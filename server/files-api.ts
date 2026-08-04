/**
 * Connector-global Files API — single enforcement boundary for external-file reads.
 *
 * Invariants (locked v1):
 * 1. Connector-global: every provider read goes through this module. Agent never
 *    calls Google/Box/object-storage directly. Owner tokens stay server-side.
 * 2. drive_resource = file or folder pointer (vault-scoped bind).
 * 3. Folder bind = recursive whitelist. Explicit file bind is also allowed inside
 *    a non-whitelisted folder.
 * 4. Read-only for v1.
 * 5. Connector owns the vault relationship (like email connectors).
 *
 * Path: resolve target → authorize (bind ownership | object_grant | vault gate)
 * → owner token (system-elevated mint, when needed) → provider adapter.
 * Fail closed on disconnect, missing drive.file, or non-whitelist. Never ambient crawl.
 *
 * Transport lives in files-providers.ts (GoogleDriveAdapter / BoxAdapter /
 * MantraStorageAdapter). FilesApi never leaks provider clients past this boundary.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "./db";
import { driveResources, type DriveResourceRow } from "@shared/schema";
import { vaults } from "@shared/models/vaults";
import { createLogger } from "./log";
import {
  requireCurrentUserPrincipal,
  runWithPrincipal,
} from "./principal-context";
import { createSystemPrincipal, type Principal } from "./principal";
import { getDriveAccessTokenForAccount } from "./gmail";
import { getAccount } from "./connected-accounts";
import {
  liveObjectGrantPredicate,
  liveVaultGatePredicate,
  objectGrantIdentity,
  type ObjectGrantIdentity,
  type ObjectRole,
} from "./authorize";
import {
  getFilesProviderAdapter,
  type AdapterContext,
  type FilesProvider,
  type FilesProviderAdapter,
} from "./files-providers";

const log = createLogger("FilesApi");

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_LIST_PAGE = 100;
const MAX_PARENT_WALK = 32;

export type { FilesProvider };

export interface FilesChild {
  provider: FilesProvider;
  providerFileId: string;
  name: string;
  mimeType: string | null;
  resourceType: "file" | "folder";
  iconUrl: string | null;
  webViewLink: string | null;
  /** Set when this child is itself an explicit bind. */
  driveResourceId: string | null;
  /** True when visible only via an ancestor folder bind. */
  viaFolderBind: boolean;
}

export interface FilesMetadata {
  provider: FilesProvider;
  providerFileId: string;
  name: string;
  mimeType: string | null;
  resourceType: "file" | "folder";
  iconUrl: string | null;
  webViewLink: string | null;
  size: string | null;
  modifiedTime: string | null;
  md5Checksum: string | null;
  driveResourceId: string;
  vaultId: string;
  connectedAccountId: string;
}

export interface FilesReadResult {
  metadata: FilesMetadata;
  contentType: string;
  text: string | null;
  base64: string | null;
  byteLength: number;
  truncated: boolean;
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function driveResourceGrantIdentity(_driveResourceId: string): ObjectGrantIdentity {
  // Column form so the predicate joins object_grants.object_id → drive_resources.id
  // inside authorizeBoundResource's driveResources WHERE (same pattern as work objects).
  // vaultId enables the vault-gate: a live vault grant authorizes binds inside it.
  return objectGrantIdentity("drive_resource", {
    objectId: driveResources.id,
    ownerUserId: driveResources.addedByUserId,
    accountId: driveResources.accountId,
    vaultId: driveResources.vaultId,
  });
}

/**
 * Vault access = account owns the vault OR live vault grant.
 * Vault gate first — no ambient cross-vault listing.
 */
async function assertVaultAccess(
  principal: Principal,
  vaultId: string,
  required: ObjectRole = "read",
): Promise<void> {
  if (!principal.accountId && principal.actorType !== "system") {
    throw httpError(401, "Account principal required");
  }

  const ownPred =
    principal.accountId != null
      ? eq(vaults.accountId, principal.accountId)
      : sql`FALSE`;

  const [vault] = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(
      and(
        eq(vaults.id, vaultId),
        or(ownPred, liveVaultGatePredicate(principal, vaults.id, required)),
      ),
    )
    .limit(1);

  if (!vault) throw httpError(404, "Vault not found");
}

/**
 * Authorize a bound drive_resource.
 * Access = bind account owns it OR live object_grant OR live vault grant on its vault.
 */
async function authorizeBoundResource(
  principal: Principal,
  driveResourceId: string,
  required: ObjectRole = "read",
): Promise<DriveResourceRow> {
  if (!principal.accountId && principal.actorType !== "system") {
    throw httpError(401, "Account principal required");
  }

  const identity = driveResourceGrantIdentity(driveResourceId);
  const ownPred =
    principal.accountId != null
      ? eq(driveResources.accountId, principal.accountId)
      : sql`FALSE`;

  const [row] = await db
    .select()
    .from(driveResources)
    .where(
      and(
        eq(driveResources.id, driveResourceId),
        or(
          ownPred,
          liveObjectGrantPredicate(principal, identity, required),
          liveVaultGatePredicate(principal, driveResources.vaultId, required),
        ),
      ),
    )
    .limit(1);

  if (!row) throw httpError(404, "Drive resource not found");
  return row;
}

/**
 * Mint adapter context for a connector.
 * Google: system-elevated owner token from connected_accounts.
 * Mantra / Box: no OAuth token (Box fails closed 501 inside the adapter).
 */
async function adapterContextForConnector(
  provider: string,
  connectedAccountId: string,
): Promise<{ adapter: FilesProviderAdapter; ctx: AdapterContext }> {
  const adapter = getFilesProviderAdapter(provider);

  if (provider === "mantra" || provider === "box") {
    return {
      adapter,
      ctx: { connectedAccountId, accessToken: null },
    };
  }

  // Google (and any future OAuth provider): mint binder token as system.
  const accessToken = await runWithPrincipal(createSystemPrincipal(), async () => {
    const account = await getAccount(connectedAccountId);
    if (!account) {
      throw httpError(403, "Connected account disconnected or missing");
    }
    try {
      const { accessToken: token } =
        await getDriveAccessTokenForAccount(connectedAccountId);
      return token;
    } catch (err) {
      log.warn("Failed to mint Drive token for connector", {
        connectedAccountId,
        err: err instanceof Error ? err.message : String(err),
      });
      throw httpError(
        403,
        "Drive access unavailable — reconnect Google with drive.file scope",
      );
    }
  });

  return {
    adapter,
    ctx: { connectedAccountId, accessToken },
  };
}

/**
 * Walk parents via the provider adapter until a folder bind is hit or depth exhausted.
 * Folder bind = recursive whitelist for that connector.
 */
async function isUnderAnyFolderBind(
  adapter: FilesProviderAdapter,
  ctx: AdapterContext,
  providerFileId: string,
  folderBindIds: Set<string>,
): Promise<boolean> {
  if (folderBindIds.has(providerFileId)) return true;

  let current = providerFileId;
  for (let i = 0; i < MAX_PARENT_WALK; i++) {
    const parents = await adapter.getParentIds(ctx, current);
    if (parents.length === 0) return false;
    for (const p of parents) {
      if (folderBindIds.has(p)) return true;
    }
    // Continue walk on the first parent (Drive files usually have one).
    current = parents[0]!;
  }
  return false;
}

function isTextLike(mime: string | null | undefined): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase();
  return (
    m.startsWith("text/") ||
    m === "application/json" ||
    m === "application/xml" ||
    m === "application/javascript" ||
    m.endsWith("+json") ||
    m.endsWith("+xml") ||
    m === "application/csv" ||
    m === "text/csv"
  );
}

class FilesApi {
  /** Bound roots in a vault — no ambient provider crawl. */
  async listBound(vaultId: string): Promise<DriveResourceRow[]> {
    const principal = requireCurrentUserPrincipal();
    await assertVaultAccess(principal, vaultId);

    return db
      .select()
      .from(driveResources)
      .where(eq(driveResources.vaultId, vaultId));
  }

  /**
   * List children of a bound folder, or of a folder under a bound folder tree.
   * Whitelist: target must be a folder bind, or a folder reachable under one.
   */
  async listChildren(input: {
    vaultId: string;
    driveResourceId?: string;
    provider?: FilesProvider;
    providerFileId?: string;
    pageToken?: string;
  }): Promise<{ children: FilesChild[]; nextPageToken: string | null }> {
    const principal = requireCurrentUserPrincipal();
    await assertVaultAccess(principal, input.vaultId);

    let folderId: string;
    let provider: FilesProvider;
    let connectorId: string;
    let folderBindsForConnector: DriveResourceRow[] = [];

    if (input.driveResourceId) {
      const bind = await authorizeBoundResource(principal, input.driveResourceId);
      if (bind.vaultId !== input.vaultId) {
        throw httpError(400, "drive_resource is not in this vault");
      }
      if (bind.resourceType !== "folder") {
        throw httpError(400, "listChildren requires a folder bind");
      }
      folderId = bind.providerFileId;
      provider = bind.provider as FilesProvider;
      connectorId = bind.connectedAccountId;
      folderBindsForConnector = await db
        .select()
        .from(driveResources)
        .where(
          and(
            eq(driveResources.vaultId, input.vaultId),
            eq(driveResources.connectedAccountId, connectorId),
            eq(driveResources.provider, provider),
            eq(driveResources.resourceType, "folder"),
          ),
        );
    } else if (input.provider && input.providerFileId) {
      provider = input.provider;
      folderId = input.providerFileId;

      const folderBinds = await db
        .select()
        .from(driveResources)
        .where(
          and(
            eq(driveResources.vaultId, input.vaultId),
            eq(driveResources.provider, provider),
            eq(driveResources.resourceType, "folder"),
          ),
        );
      if (folderBinds.length === 0) {
        throw httpError(403, "No folder binds for this provider in vault");
      }

      const byConnector = new Map<string, DriveResourceRow[]>();
      for (const f of folderBinds) {
        const list = byConnector.get(f.connectedAccountId) ?? [];
        list.push(f);
        byConnector.set(f.connectedAccountId, list);
      }

      let resolved: {
        connectorId: string;
        binds: DriveResourceRow[];
      } | null = null;

      for (const [cid, binds] of byConnector) {
        let authorized = false;
        for (const b of binds) {
          try {
            await authorizeBoundResource(principal, b.id);
            authorized = true;
            break;
          } catch {
            // try next bind
          }
        }
        if (!authorized) continue;

        const { adapter, ctx } = await adapterContextForConnector(provider, cid);
        const folderIds = new Set(binds.map((b) => b.providerFileId));
        if (
          folderIds.has(folderId) ||
          (await isUnderAnyFolderBind(adapter, ctx, folderId, folderIds))
        ) {
          resolved = { connectorId: cid, binds };
          break;
        }
      }

      if (!resolved) {
        throw httpError(403, "Folder is not under any authorized folder bind");
      }
      connectorId = resolved.connectorId;
      folderBindsForConnector = resolved.binds;
    } else {
      throw httpError(
        400,
        "listChildren requires driveResourceId or provider+providerFileId",
      );
    }

    const { adapter, ctx } = await adapterContextForConnector(
      provider,
      connectorId,
    );
    const result = await adapter.listChildren(ctx, {
      folderId,
      pageToken: input.pageToken,
      pageSize: MAX_LIST_PAGE,
    });

    const childIds = result.children.map((c) => c.providerFileId);
    const explicitBinds =
      childIds.length === 0
        ? []
        : await db
            .select()
            .from(driveResources)
            .where(
              and(
                eq(driveResources.vaultId, input.vaultId),
                eq(driveResources.connectedAccountId, connectorId),
                eq(driveResources.provider, provider),
                inArray(driveResources.providerFileId, childIds),
              ),
            );
    const bindByFileId = new Map(
      explicitBinds.map((b) => [b.providerFileId, b] as const),
    );
    const folderBindIds = new Set(
      folderBindsForConnector.map((b) => b.providerFileId),
    );

    const children: FilesChild[] = result.children.map((c) => {
      const bind = bindByFileId.get(c.providerFileId) ?? null;
      return {
        provider: c.provider,
        providerFileId: c.providerFileId,
        name: c.name,
        mimeType: c.mimeType,
        resourceType: c.resourceType,
        iconUrl: c.iconUrl,
        webViewLink: c.webViewLink,
        driveResourceId: bind?.id ?? null,
        viaFolderBind: !bind && folderBindIds.size > 0,
      };
    });

    return { children, nextPageToken: result.nextPageToken };
  }

  async getMetadata(input: {
    vaultId?: string;
    driveResourceId?: string;
    provider?: FilesProvider;
    providerFileId?: string;
  }): Promise<FilesMetadata> {
    const principal = requireCurrentUserPrincipal();

    let provider: FilesProvider;
    let providerFileId: string;
    let connectorId: string;
    let driveResourceId: string;
    let vaultId: string;

    if (input.driveResourceId) {
      const bind = await authorizeBoundResource(principal, input.driveResourceId);
      if (input.vaultId && bind.vaultId !== input.vaultId) {
        throw httpError(400, "drive_resource is not in this vault");
      }
      provider = bind.provider as FilesProvider;
      providerFileId = bind.providerFileId;
      connectorId = bind.connectedAccountId;
      driveResourceId = bind.id;
      vaultId = bind.vaultId;
      await assertVaultAccess(principal, vaultId);
    } else if (input.vaultId && input.provider && input.providerFileId) {
      await assertVaultAccess(principal, input.vaultId);
      const resolved = await this.resolveWhitelistedTarget(
        principal,
        input.vaultId,
        input.provider,
        input.providerFileId,
      );
      provider = input.provider;
      providerFileId = input.providerFileId;
      connectorId = resolved.connectorId;
      driveResourceId = resolved.driveResourceId;
      vaultId = input.vaultId;
    } else {
      throw httpError(
        400,
        "getMetadata requires driveResourceId or vaultId+provider+providerFileId",
      );
    }

    const { adapter, ctx } = await adapterContextForConnector(
      provider,
      connectorId,
    );
    const meta = await adapter.getMetadata(ctx, providerFileId);
    return {
      provider: meta.provider,
      providerFileId: meta.providerFileId,
      name: meta.name,
      mimeType: meta.mimeType,
      resourceType: meta.resourceType,
      iconUrl: meta.iconUrl,
      webViewLink: meta.webViewLink,
      size: meta.size,
      modifiedTime: meta.modifiedTime,
      md5Checksum: meta.md5Checksum,
      driveResourceId,
      vaultId,
      connectedAccountId: connectorId,
    };
  }

  /**
   * Read file bytes/text (v1 read-only). Folders rejected.
   * Google editors exported to text/csv; binary returned as base64.
   */
  async read(input: {
    vaultId?: string;
    driveResourceId?: string;
    provider?: FilesProvider;
    providerFileId?: string;
  }): Promise<FilesReadResult> {
    const metadata = await this.getMetadata(input);
    if (metadata.resourceType === "folder") {
      throw httpError(400, "Cannot read a folder — use listChildren");
    }

    const { adapter, ctx } = await adapterContextForConnector(
      metadata.provider,
      metadata.connectedAccountId,
    );

    try {
      const bytes = await adapter.readBytes(ctx, metadata.providerFileId, {
        maxBytes: MAX_READ_BYTES,
        mimeType: metadata.mimeType,
      });

      const truncated = bytes.truncated || bytes.byteLength > MAX_READ_BYTES;
      const buf = truncated
        ? bytes.buffer.subarray(0, Math.min(bytes.buffer.length, MAX_READ_BYTES))
        : bytes.buffer;
      const contentType = bytes.contentType || metadata.mimeType || "application/octet-stream";
      const text = isTextLike(contentType) ? buf.toString("utf8") : null;
      const base64 = text == null ? buf.toString("base64") : null;

      return {
        metadata,
        contentType,
        text,
        base64,
        byteLength: buf.length,
        truncated,
      };
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 403 || status === 404 || status === 501) throw err;
      // Google drive.file often surfaces as 404 when outside grants.
      const msg = err instanceof Error ? err.message : String(err);
      if (/403|insufficient|not found|404/i.test(msg)) {
        throw httpError(
          403,
          "Provider denied read — file may be outside drive.file grants. Re-pick via Picker.",
        );
      }
      log.error("Files read failed", {
        provider: metadata.provider,
        providerFileId: metadata.providerFileId,
        err: msg,
      });
      throw httpError(502, "Provider read failed");
    }
  }

  /**
   * Authorize a bound drive_resource for the current principal.
   * Used by routes that only need the bind row after the grant check.
   */
  async authorize(
    driveResourceId: string,
    required: ObjectRole = "read",
  ): Promise<DriveResourceRow> {
    const principal = requireCurrentUserPrincipal();
    return authorizeBoundResource(principal, driveResourceId, required);
  }

  /**
   * Resolve provider+providerFileId against vault binds:
   * explicit file bind preferred, else under an authorized folder bind.
   */
  private async resolveWhitelistedTarget(
    principal: Principal,
    vaultId: string,
    provider: FilesProvider,
    providerFileId: string,
  ): Promise<{ connectorId: string; driveResourceId: string }> {
    const fileBinds = await db
      .select()
      .from(driveResources)
      .where(
        and(
          eq(driveResources.vaultId, vaultId),
          eq(driveResources.provider, provider),
          eq(driveResources.resourceType, "file"),
          eq(driveResources.providerFileId, providerFileId),
        ),
      );

    for (const bind of fileBinds) {
      try {
        await authorizeBoundResource(principal, bind.id);
        return {
          connectorId: bind.connectedAccountId,
          driveResourceId: bind.id,
        };
      } catch {
        // try next
      }
    }

    const folderBinds = await db
      .select()
      .from(driveResources)
      .where(
        and(
          eq(driveResources.vaultId, vaultId),
          eq(driveResources.provider, provider),
          eq(driveResources.resourceType, "folder"),
        ),
      );

    if (folderBinds.length === 0) {
      throw httpError(
        403,
        "File is not whitelisted — pick it explicitly or bind a parent folder",
      );
    }

    const byConnector = new Map<string, DriveResourceRow[]>();
    for (const f of folderBinds) {
      const list = byConnector.get(f.connectedAccountId) ?? [];
      list.push(f);
      byConnector.set(f.connectedAccountId, list);
    }

    for (const [cid, binds] of byConnector) {
      let authorizedBind: DriveResourceRow | null = null;
      for (const b of binds) {
        try {
          await authorizeBoundResource(principal, b.id);
          authorizedBind = b;
          break;
        } catch {
          // try next
        }
      }
      if (!authorizedBind) continue;

      const { adapter, ctx } = await adapterContextForConnector(provider, cid);
      const folderIds = new Set(binds.map((b) => b.providerFileId));
      if (await isUnderAnyFolderBind(adapter, ctx, providerFileId, folderIds)) {
        return {
          connectorId: cid,
          driveResourceId: authorizedBind.id,
        };
      }
    }

    throw httpError(
      403,
      "File is not whitelisted — pick it explicitly or bind a parent folder",
    );
  }
}

export const filesApi = new FilesApi();
