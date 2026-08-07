/**
 * Files index policy mutation boundary.
 *
 * Indexing is a policy over canonical drive_resources:
 * - file toggle → mode self|off; materialize/retire one indexed_file_source; enqueue drive_file
 * - folder toggle → mode recursive|off; schedule reconciliation run (worker advances phases)
 *
 * Coverage (v1, no per-child exclusions):
 * A discovered file stays indexed while ANY active policy covers it (explicit self on the
 * bind, or recursive ancestor). Turning a folder off stops future discovery and retires only
 * sources whose sole covering policy was that folder. Overlap-safe retirement is finalized by
 * the reconciler; this service retires the direct self-source on disable and enqueues a
 * reconciliation run so recursive coverage can be recomputed.
 *
 * Semantic extraction state remains exclusively in memory_vnext_source_queue.
 */
import { and, desc, eq, inArray, ne, or } from "drizzle-orm";
import {
  driveResources,
  fileIndexPolicies,
  fileIndexReconciliationRuns,
  indexedFileSources,
  type DriveResourceRow,
  type FileIndexPolicyMode,
  type FileIndexPolicyRow,
  type FileIndexReconciliationRunRow,
  type IndexedFileSourceRow,
} from "@shared/schema";
import { vaults } from "@shared/models/vaults";
import { db } from "./db";
import { createLogger } from "./log";
import { requireCurrentUserPrincipal } from "./principal-context";
import type { Principal } from "./principal";
import { liveVaultGatePredicate, type ObjectRole } from "./authorize";
import { markSourceChanged } from "./memory/vnext-source-queue";
import { retryFailedFilesIndexRun } from "./files-index-reconciler";

const log = createLogger("FilesIndexService");

const ACTIVE_RECON_PHASES = ["queued", "discovering", "indexing"] as const;

export type FileIndexUiStatus =
  | "off"
  | "self"
  | "recursive"
  | "indexing"
  | "unsupported"
  | "error"
  | "retired";

export interface FileIndexStatus {
  driveResourceId: string;
  resourceType: "file" | "folder";
  vaultId: string;
  /** Explicit policy mode on this bind; defaults to off when no row. */
  mode: FileIndexPolicyMode;
  policyId: string | null;
  /** Materialized source for this bind when present (self or discovered under another root). */
  indexedSource: IndexedFileSourceRow | null;
  /** Active or latest reconciliation run for folder policies. */
  reconciliationRun: FileIndexReconciliationRunRow | null;
  /** Compact UI discriminant for Files rows (inherited labels land with reconciler). */
  status: FileIndexUiStatus;
}

function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

function resolveToggleMode(
  resourceType: "file" | "folder",
  enabled: boolean,
  explicitMode?: FileIndexPolicyMode,
): FileIndexPolicyMode {
  if (explicitMode) {
    if (explicitMode === "off") return "off";
    if (resourceType === "file" && explicitMode === "self") return "self";
    if (resourceType === "folder" && explicitMode === "recursive") return "recursive";
    throw httpError(
      resourceType === "file"
        ? "file index mode must be off or self"
        : "folder index mode must be off or recursive",
      400,
    );
  }
  if (!enabled) return "off";
  return resourceType === "folder" ? "recursive" : "self";
}

function statusFromParts(input: {
  mode: FileIndexPolicyMode;
  resourceType: "file" | "folder";
  source: IndexedFileSourceRow | null;
  run: FileIndexReconciliationRunRow | null;
}): FileIndexUiStatus {
  if (input.run && ACTIVE_RECON_PHASES.includes(input.run.phase as (typeof ACTIVE_RECON_PHASES)[number])) {
    return "indexing";
  }
  if (input.run?.phase === "failed") return "error";
  if (input.source?.discoveryState === "unsupported") return "unsupported";
  if (input.source?.discoveryState === "retired" && input.mode === "off") return "retired";
  if (input.mode === "self") return "self";
  if (input.mode === "recursive") return "recursive";
  if (input.source && input.source.discoveryState === "active") return "self";
  return "off";
}

export class FilesIndexService {
  private async assertVaultAccess(vaultId: string, required: ObjectRole): Promise<void> {
    const principal = requireCurrentUserPrincipal();
    const [vault] = await db
      .select({ id: vaults.id })
      .from(vaults)
      .where(
        and(
          eq(vaults.id, vaultId),
          or(
            eq(vaults.accountId, principal.accountId),
            liveVaultGatePredicate(principal, vaults.id, required),
          ),
        ),
      )
      .limit(1);
    if (!vault) throw httpError("Vault not found", 404);
  }

  private async loadAuthorizedResource(driveResourceId: string): Promise<DriveResourceRow> {
    const principal = requireCurrentUserPrincipal();
    const [resource] = await db
      .select()
      .from(driveResources)
      .where(
        and(
          eq(driveResources.id, driveResourceId),
          or(
            eq(driveResources.accountId, principal.accountId),
            liveVaultGatePredicate(principal, driveResources.vaultId, "read"),
          ),
        ),
      )
      .limit(1);
    if (!resource) throw httpError("Drive resource not found", 404);
    await this.assertVaultAccess(resource.vaultId, "read");
    return resource;
  }

  private async loadPolicyForResource(
    driveResourceId: string,
  ): Promise<FileIndexPolicyRow | null> {
    const [row] = await db
      .select()
      .from(fileIndexPolicies)
      .where(eq(fileIndexPolicies.driveResourceId, driveResourceId))
      .limit(1);
    return row ?? null;
  }

  private async loadSourceForDriveResource(
    driveResourceId: string,
  ): Promise<IndexedFileSourceRow | null> {
    const [row] = await db
      .select()
      .from(indexedFileSources)
      .where(eq(indexedFileSources.driveResourceId, driveResourceId))
      .limit(1);
    return row ?? null;
  }

  private async loadLatestRunForPolicy(
    policyId: string,
  ): Promise<FileIndexReconciliationRunRow | null> {
    const [row] = await db
      .select()
      .from(fileIndexReconciliationRuns)
      .where(eq(fileIndexReconciliationRuns.policyId, policyId))
      .orderBy(desc(fileIndexReconciliationRuns.createdAt))
      .limit(1);
    return row ?? null;
  }

  private async loadActiveRunForPolicy(
    policyId: string,
  ): Promise<FileIndexReconciliationRunRow | null> {
    const [row] = await db
      .select()
      .from(fileIndexReconciliationRuns)
      .where(
        and(
          eq(fileIndexReconciliationRuns.policyId, policyId),
          inArray(fileIndexReconciliationRuns.phase, [...ACTIVE_RECON_PHASES]),
        ),
      )
      .orderBy(desc(fileIndexReconciliationRuns.createdAt))
      .limit(1);
    return row ?? null;
  }

  async getStatus(driveResourceId: string): Promise<FileIndexStatus> {
    const resource = await this.loadAuthorizedResource(driveResourceId);
    const policy = await this.loadPolicyForResource(resource.id);
    const mode = (policy?.mode ?? "off") as FileIndexPolicyMode;
    const indexedSource = await this.loadSourceForDriveResource(resource.id);
    const reconciliationRun = policy ? await this.loadLatestRunForPolicy(policy.id) : null;
    return {
      driveResourceId: resource.id,
      resourceType: resource.resourceType,
      vaultId: resource.vaultId,
      mode,
      policyId: policy?.id ?? null,
      indexedSource,
      reconciliationRun,
      status: statusFromParts({
        mode,
        resourceType: resource.resourceType,
        source: indexedSource,
        run: reconciliationRun,
      }),
    };
  }

  async listStatusesForVault(vaultId: string): Promise<FileIndexStatus[]> {
    await this.assertVaultAccess(vaultId, "read");
    const principal = requireCurrentUserPrincipal();
    const resources = await db
      .select()
      .from(driveResources)
      .where(
        and(
          eq(driveResources.vaultId, vaultId),
          or(
            eq(driveResources.accountId, principal.accountId),
            liveVaultGatePredicate(principal, driveResources.vaultId, "read"),
          ),
        ),
      );

    if (resources.length === 0) return [];

    const resourceIds = resources.map((r) => r.id);
    const policies = await db
      .select()
      .from(fileIndexPolicies)
      .where(inArray(fileIndexPolicies.driveResourceId, resourceIds));
    const policyByResource = new Map(policies.map((p) => [p.driveResourceId, p]));

    const sources = await db
      .select()
      .from(indexedFileSources)
      .where(inArray(indexedFileSources.driveResourceId, resourceIds));
    const sourceByResource = new Map(
      sources
        .filter((s): s is IndexedFileSourceRow & { driveResourceId: string } => !!s.driveResourceId)
        .map((s) => [s.driveResourceId, s]),
    );

    const policyIds = policies.map((p) => p.id);
    const runs =
      policyIds.length === 0
        ? []
        : await db
            .select()
            .from(fileIndexReconciliationRuns)
            .where(inArray(fileIndexReconciliationRuns.policyId, policyIds))
            .orderBy(desc(fileIndexReconciliationRuns.createdAt));
    const latestRunByPolicy = new Map<string, FileIndexReconciliationRunRow>();
    for (const run of runs) {
      if (!latestRunByPolicy.has(run.policyId)) latestRunByPolicy.set(run.policyId, run);
    }

    return resources.map((resource) => {
      const policy = policyByResource.get(resource.id) ?? null;
      const mode = (policy?.mode ?? "off") as FileIndexPolicyMode;
      const indexedSource = sourceByResource.get(resource.id) ?? null;
      const reconciliationRun = policy ? latestRunByPolicy.get(policy.id) ?? null : null;
      return {
        driveResourceId: resource.id,
        resourceType: resource.resourceType,
        vaultId: resource.vaultId,
        mode,
        policyId: policy?.id ?? null,
        indexedSource,
        reconciliationRun,
        status: statusFromParts({
          mode,
          resourceType: resource.resourceType,
          source: indexedSource,
          run: reconciliationRun,
        }),
      };
    });
  }

  /**
   * Idempotent enable/disable for a bound file or folder.
   * enabled=true maps file→self, folder→recursive; enabled=false → off.
   * Optional mode overrides the boolean when provided.
   */
  async setIndexPolicy(input: {
    driveResourceId: string;
    enabled?: boolean;
    mode?: FileIndexPolicyMode;
  }): Promise<FileIndexStatus> {
    const principal = requireCurrentUserPrincipal();
    const resource = await this.loadAuthorizedResource(input.driveResourceId);
    // Policy mutation requires write on the vault (owner or write grant).
    await this.assertVaultAccess(resource.vaultId, "write");

    const enabled = input.enabled ?? input.mode !== "off";
    const mode = resolveToggleMode(resource.resourceType, enabled, input.mode);

    const policy = await this.upsertPolicy({
      principal,
      resource,
      mode,
    });

    if (resource.resourceType === "file") {
      if (mode === "self") {
        await this.materializeSelfSource({ principal, resource, policy });
        await markSourceChanged("drive_file", resource.id, principal);
        log.info("file index enabled", {
          driveResourceId: resource.id,
          policyId: policy.id,
          mode,
        });
      } else {
        await this.retireSelfSourceIfUncovered({ principal, resource, policy });
        log.info("file index disabled", {
          driveResourceId: resource.id,
          policyId: policy.id,
        });
      }
    } else {
      // Folder: recursive rule. Always schedule a reconciliation stub so step 3 can
      // expand (enable) or recompute coverage/retire (disable). Idempotent: reuse active run.
      const run = await this.enqueueReconciliationRun({ principal, resource, policy });
      log.info("folder index policy set; reconciliation enqueued", {
        driveResourceId: resource.id,
        policyId: policy.id,
        mode,
        runId: run.id,
        phase: run.phase,
      });
    }

    return this.getStatus(resource.id);
  }

  private async upsertPolicy(input: {
    principal: Principal;
    resource: DriveResourceRow;
    mode: FileIndexPolicyMode;
  }): Promise<FileIndexPolicyRow> {
    const { principal, resource, mode } = input;
    const now = new Date();
    const [row] = await db
      .insert(fileIndexPolicies)
      .values({
        accountId: resource.accountId,
        ownerUserId: principal.userId,
        vaultId: resource.vaultId,
        driveResourceId: resource.id,
        mode,
        createdByUserId: principal.userId,
        updatedByUserId: principal.userId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [fileIndexPolicies.driveResourceId],
        set: {
          mode,
          updatedByUserId: principal.userId,
          updatedAt: now,
          // Keep ownership on the original owner; do not reassign on toggle replay.
        },
      })
      .returning();
    return row;
  }

  private async materializeSelfSource(input: {
    principal: Principal;
    resource: DriveResourceRow;
    policy: FileIndexPolicyRow;
  }): Promise<IndexedFileSourceRow> {
    const { principal, resource, policy } = input;
    const now = new Date();
    const [row] = await db
      .insert(indexedFileSources)
      .values({
        accountId: resource.accountId,
        ownerUserId: principal.userId,
        vaultId: resource.vaultId,
        policyId: policy.id,
        rootDriveResourceId: resource.id,
        driveResourceId: resource.id,
        provider: resource.provider,
        providerFileId: resource.providerFileId,
        name: resource.name,
        mimeType: resource.mimeType,
        discoveryState: "active",
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
          rootDriveResourceId: resource.id,
          driveResourceId: resource.id,
          name: resource.name,
          mimeType: resource.mimeType,
          discoveryState: "active",
          lastDiscoveredAt: now,
          retiredAt: null,
          updatedAt: now,
        },
      })
      .returning();
    return row;
  }

  /**
   * Retire the direct self-source when disabling a file policy.
   * If another active policy still covers this source (future recursive coverage),
   * the reconciler will reactivate it; v1 file-disable only clears explicit self.
   */
  private async retireSelfSourceIfUncovered(input: {
    principal: Principal;
    resource: DriveResourceRow;
    policy: FileIndexPolicyRow;
  }): Promise<void> {
    const { resource } = input;
    const now = new Date();
    await db
      .update(indexedFileSources)
      .set({
        discoveryState: "retired",
        retiredAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(indexedFileSources.driveResourceId, resource.id),
          // Only retire when this policy is the recorded provenance root OR no other
          // active non-off policy exists on the same bind (self-only in v1).
          or(
            eq(indexedFileSources.policyId, input.policy.id),
            eq(indexedFileSources.rootDriveResourceId, resource.id),
          ),
          ne(indexedFileSources.discoveryState, "retired"),
        ),
      );
  }

  /**
   * Enqueue a durable reconciliation run. Idempotent while a run is already
   * queued/discovering/indexing for the same policy — returns the active row.
   * The background reconciler advances phase and counters.
   */
  private async enqueueReconciliationRun(input: {
    principal: Principal;
    resource: DriveResourceRow;
    policy: FileIndexPolicyRow;
  }): Promise<FileIndexReconciliationRunRow> {
    const { principal, resource, policy } = input;
    const active = await this.loadActiveRunForPolicy(policy.id);
    if (active) {
      const [bumped] = await db
        .update(fileIndexReconciliationRuns)
        .set({ updatedAt: new Date() })
        .where(eq(fileIndexReconciliationRuns.id, active.id))
        .returning();
      return bumped ?? active;
    }

    const now = new Date();
    const [row] = await db
      .insert(fileIndexReconciliationRuns)
      .values({
        accountId: resource.accountId,
        ownerUserId: principal.userId,
        vaultId: resource.vaultId,
        policyId: policy.id,
        rootDriveResourceId: resource.id,
        phase: "queued",
        updatedAt: now,
        createdAt: now,
      })
      .returning();
    return row;
  }

  /**
   * Retry only failed files from a partial/failed run without restarting full
   * tree discovery. Overlap-safe and principal-scoped.
   */
  async retryFailedRun(runId: string): Promise<FileIndexStatus> {
    const principal = requireCurrentUserPrincipal();
    const run = await retryFailedFilesIndexRun({ principal, runId });
    return this.getStatus(run.rootDriveResourceId);
  }

  async getRun(runId: string): Promise<FileIndexReconciliationRunRow> {
    const principal = requireCurrentUserPrincipal();
    const [row] = await db
      .select()
      .from(fileIndexReconciliationRuns)
      .where(
        and(
          eq(fileIndexReconciliationRuns.id, runId),
          eq(fileIndexReconciliationRuns.accountId, principal.accountId!),
        ),
      )
      .limit(1);
    if (!row) throw httpError("Reconciliation run not found", 404);
    return row;
  }
}

export const filesIndexService = new FilesIndexService();
