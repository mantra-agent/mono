/**
 * Connector-global Files API — single enforcement boundary for external-file reads.
 *
 * Invariants (locked v1):
 * 1. Connector-global: every provider read goes through this module. Agent never
 *    calls Google/Box directly. Owner tokens stay server-side.
 * 2. drive_resource = file or folder pointer (vault-scoped bind).
 * 3. Folder bind = recursive whitelist. Explicit file bind is also allowed inside
 *    a non-whitelisted folder.
 * 4. Read-only for v1.
 * 5. Connector owns the vault relationship (like email connectors).
 *
 * Path: resolve target → authorize (bind ownership | object_grant | vault gate)
 * → owner token (system-elevated mint) → provider. Fail closed on disconnect,
 * missing drive.file, or non-whitelist. Never ambient crawl.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { google, type drive_v3 } from "googleapis";
import { db } from "./db";
import { driveResources, type DriveResourceRow } from "@shared/schema";
import { vaults } from "@shared/models/vaults";
import { createLogger } from "./log";
import {
  requireCurrentUserPrincipal,
  runWithPrincipal,
} from "./principal-context";
import { createSystemPrincipal, type Principal } from "./principal";
import { getDriveAccessTokenForAccount, getOAuth2Client } from "./gmail";
import { getAccount } from "./connected-accounts";
import {
  liveObjectGrantPredicate,
  liveVaultGatePredicate,
  objectGrantIdentity,
  type ObjectGrantIdentity,
  type ObjectRole,
} from "./authorize";

const log = createLogger("FilesApi");

const FOLDER_MIME = "application/vnd.google-apps.folder";
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_LIST_PAGE = 100;
const MAX_PARENT_WALK = 32;

const GOOGLE_EXPORT_MAP: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

export type FilesProvider = "google" | "box" | "mantra";

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

function mapResourceType(mimeType: string | null | undefined): "file" | "folder" {
  return mimeType === FOLDER_MIME ? "folder" : "file";
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
 * Mint a Drive client as the connector owner.
 * Elevates to system principal so grantee reads can use the binder's token
 * without principal-scoping the connected_accounts row. Token never leaves server.
 */
async function driveClientForConnector(
  connectedAccountId: string,
): Promise<drive_v3.Drive> {
  return runWithPrincipal(createSystemPrincipal(), async () => {
    const account = await getAccount(connectedAccountId);
    if (!account) {
      throw httpError(
        403,
        "Connector disconnected — reconnect Google to read this file",
      );
    }

    // Validates drive.file scope and refreshes; throws on missing scope/disconnect.
    const { accessToken, expiresAt } =
      await getDriveAccessTokenForAccount(connectedAccountId);
    const oauth2Client = await getOAuth2Client();
    oauth2Client.setCredentials({
      access_token: accessToken,
      expiry_date: expiresAt ?? undefined,
    });
    return google.drive({ version: "v3", auth: oauth2Client });
  });
}

/**
 * Resolve whitelist coverage for a provider file id inside a vault.
 * Exact file bind wins; otherwise walk parents until a folder bind matches.
 * Fail closed when nothing covers the target — caller must re-prompt Picker.
 * Parent walk is Google-only today; other providers require exact binds.
 */
async function resolveWhitelist(
  principal: Principal,
  vaultId: string,
  provider: FilesProvider,
  providerFileId: string,
): Promise<{ bind: DriveResourceRow; viaFolderBind: boolean }> {
  await assertVaultAccess(principal, vaultId, "read");

  // All binds in the vault (owner or vault-grantee sees the vault's whitelist).
  const binds = await db
    .select()
    .from(driveResources)
    .where(eq(driveResources.vaultId, vaultId));

  const exact = binds.find(
    (b) => b.provider === provider && b.providerFileId === providerFileId,
  );
  if (exact) return { bind: exact, viaFolderBind: false };

  // Non-Google providers: exact bind only (no parent walk yet).
  if (provider !== "google") {
    throw httpError(
      403,
      "File is not whitelisted — pick it explicitly or bind a parent folder",
    );
  }

  const folderBinds = binds.filter(
    (b) => b.resourceType === "folder" && b.provider === "google",
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

  for (const [connectorId, folders] of byConnector) {
    const folderIds = new Set(folders.map((f) => f.providerFileId));
    try {
      const drive = await driveClientForConnector(connectorId);
      let currentId: string | null = providerFileId;
      for (let depth = 0; depth < MAX_PARENT_WALK && currentId; depth++) {
        const meta = await drive.files.get({
          fileId: currentId,
          fields: "id,parents,trashed",
          supportsAllDrives: true,
        });
        if (meta.data.trashed) {
          throw httpError(410, "File has been trashed in Google Drive");
        }
        const parents = meta.data.parents ?? [];
        for (const parentId of parents) {
          if (folderIds.has(parentId)) {
            const bind = folders.find((f) => f.providerFileId === parentId)!;
            return { bind, viaFolderBind: true };
          }
        }
        currentId = parents[0] ?? null;
      }
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 410) throw err;
      log.warn("Whitelist parent walk failed", {
        connectorId,
        provider,
        providerFileId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  throw httpError(
    403,
    "File is not whitelisted — pick it explicitly or bind a parent folder",
  );
}

class FilesApi {
  /** Bound roots in a vault — no ambient Google crawl. */
  async listBound(vaultId: string): Promise<DriveResourceRow[]> {
    const principal = requireCurrentUserPrincipal();
    await assertVaultAccess(principal, vaultId, "read");
    return db
      .select()
      .from(driveResources)
      .where(eq(driveResources.vaultId, vaultId));
  }

  /**
   * List children of a bound folder, or of a descendant folder under a folder bind.
   * Recursive whitelist: every child of a bound folder is visible.
   */
  async listChildren(input: {
    vaultId: string;
    driveResourceId?: string;
    provider?: FilesProvider;
    providerFileId?: string;
    pageToken?: string;
  }): Promise<{ children: FilesChild[]; nextPageToken: string | null }> {
    const principal = requireCurrentUserPrincipal();

    let folderProvider: FilesProvider;
    let folderProviderFileId: string;
    let connectorId: string;
    let coveringBindId: string;
    let vaultId = input.vaultId;

    if (input.driveResourceId) {
      const bind = await authorizeBoundResource(
        principal,
        input.driveResourceId,
        "read",
      );
      if (input.vaultId && bind.vaultId !== input.vaultId) {
        throw httpError(404, "Drive resource not found");
      }
      if (bind.resourceType !== "folder") {
        throw httpError(400, "listChildren requires a folder bind");
      }
      vaultId = bind.vaultId;
      folderProvider = (bind.provider as FilesProvider) || "google";
      folderProviderFileId = bind.providerFileId;
      connectorId = bind.connectedAccountId;
      coveringBindId = bind.id;
    } else if (input.providerFileId) {
      await assertVaultAccess(principal, vaultId, "read");
      const provider = input.provider ?? "google";
      const resolved = await resolveWhitelist(
        principal,
        vaultId,
        provider,
        input.providerFileId,
      );
      folderProvider = provider;
      folderProviderFileId = input.providerFileId;
      connectorId = resolved.bind.connectedAccountId;
      coveringBindId = resolved.bind.id;
    } else {
      throw httpError(400, "driveResourceId or providerFileId required");
    }

    if (folderProvider !== "google") {
      throw httpError(501, `listChildren not implemented for provider ${folderProvider}`);
    }

    const drive = await driveClientForConnector(connectorId);

    if (input.providerFileId && !input.driveResourceId) {
      const meta = await drive.files.get({
        fileId: folderProviderFileId,
        fields: "id,mimeType,trashed",
        supportsAllDrives: true,
      });
      if (meta.data.trashed) {
        throw httpError(410, "Folder has been trashed in Google Drive");
      }
      if (meta.data.mimeType !== FOLDER_MIME) {
        throw httpError(400, "listChildren requires a folder");
      }
    }

    const escaped = folderProviderFileId.replace(/'/g, "\\'");
    const resp = await drive.files.list({
      q: `'${escaped}' in parents and trashed = false`,
      fields: "nextPageToken, files(id,name,mimeType,iconLink,webViewLink)",
      pageSize: MAX_LIST_PAGE,
      pageToken: input.pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      orderBy: "folder,name_natural",
    });

    const files = (resp.data.files ?? []).filter((f) => !!f.id);
    const childIds = files.map((f) => f.id!);

    const explicitBinds =
      childIds.length === 0
        ? []
        : await db
            .select()
            .from(driveResources)
            .where(
              and(
                eq(driveResources.vaultId, vaultId),
                eq(driveResources.provider, folderProvider),
                inArray(driveResources.providerFileId, childIds),
              ),
            );
    const bindByProviderFileId = new Map(
      explicitBinds.map((b) => [b.providerFileId, b]),
    );

    const children: FilesChild[] = files.map((f) => {
      const bind = bindByProviderFileId.get(f.id!);
      const mime = f.mimeType ?? null;
      return {
        provider: "google" as const,
        providerFileId: f.id!,
        name: f.name ?? "(untitled)",
        mimeType: mime,
        resourceType: mapResourceType(mime),
        iconUrl: f.iconLink ?? null,
        webViewLink: f.webViewLink ?? null,
        driveResourceId: bind?.id ?? null,
        viaFolderBind: !bind,
      };
    });

    log.debug("listChildren", {
      vaultId,
      provider: folderProvider,
      providerFileId: folderProviderFileId,
      count: children.length,
      coveringBindId,
    });

    return { children, nextPageToken: resp.data.nextPageToken ?? null };
  }

  /** Metadata for a bound file/folder or a whitelisted descendant. */
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
      const bind = await authorizeBoundResource(
        principal,
        input.driveResourceId,
        "read",
      );
      if (input.vaultId && bind.vaultId !== input.vaultId) {
        throw httpError(404, "Drive resource not found");
      }
      provider = (bind.provider as FilesProvider) || "google";
      providerFileId = bind.providerFileId;
      connectorId = bind.connectedAccountId;
      driveResourceId = bind.id;
      vaultId = bind.vaultId;
    } else if (input.providerFileId && input.vaultId) {
      provider = input.provider ?? "google";
      const resolved = await resolveWhitelist(
        principal,
        input.vaultId,
        provider,
        input.providerFileId,
      );
      providerFileId = input.providerFileId;
      connectorId = resolved.bind.connectedAccountId;
      driveResourceId = resolved.bind.id;
      vaultId = input.vaultId;
    } else {
      throw httpError(
        400,
        "driveResourceId, or vaultId + providerFileId, required",
      );
    }

    if (provider !== "google") {
      throw httpError(501, `getMetadata not implemented for provider ${provider}`);
    }

    const drive = await driveClientForConnector(connectorId);
    const meta = await drive.files.get({
      fileId: providerFileId,
      fields:
        "id,name,mimeType,iconLink,webViewLink,size,modifiedTime,md5Checksum,trashed",
      supportsAllDrives: true,
    });

    if (meta.data.trashed) {
      throw httpError(410, "File has been trashed in Google Drive");
    }

    const mime = meta.data.mimeType ?? null;
    return {
      provider: "google",
      providerFileId: meta.data.id ?? providerFileId,
      name: meta.data.name ?? "(untitled)",
      mimeType: mime,
      resourceType: mapResourceType(mime),
      iconUrl: meta.data.iconLink ?? null,
      webViewLink: meta.data.webViewLink ?? null,
      size: meta.data.size ?? null,
      modifiedTime: meta.data.modifiedTime ?? null,
      md5Checksum: meta.data.md5Checksum ?? null,
      driveResourceId,
      vaultId,
      connectedAccountId: connectorId,
    };
  }

  /**
   * Read file bytes/text (v1 read-only). Folders rejected.
   * Google editors exported to text/csv; binary returned as base64 up to cap.
   */
  async read(input: {
    vaultId?: string;
    driveResourceId?: string;
    provider?: FilesProvider;
    providerFileId?: string;
  }): Promise<FilesReadResult> {
    const metadata = await this.getMetadata(input);
    if (metadata.resourceType === "folder") {
      throw httpError(400, "Cannot read bytes of a folder — use listChildren");
    }

    const drive = await driveClientForConnector(metadata.connectedAccountId);
    const exportMime = metadata.mimeType
      ? GOOGLE_EXPORT_MAP[metadata.mimeType]
      : undefined;

    try {
      if (exportMime) {
        const resp = await drive.files.export(
          { fileId: metadata.providerFileId, mimeType: exportMime },
          { responseType: "arraybuffer" },
        );
        const buf = Buffer.from(resp.data as ArrayBuffer);
        const truncated = buf.byteLength > MAX_READ_BYTES;
        const slice = truncated ? buf.subarray(0, MAX_READ_BYTES) : buf;
        return {
          metadata,
          contentType: exportMime,
          text: slice.toString("utf8"),
          base64: null,
          byteLength: slice.byteLength,
          truncated,
        };
      }

      const resp = await drive.files.get(
        {
          fileId: metadata.providerFileId,
          alt: "media",
          supportsAllDrives: true,
        },
        { responseType: "arraybuffer" },
      );
      const buf = Buffer.from(resp.data as ArrayBuffer);
      const truncated = buf.byteLength > MAX_READ_BYTES;
      const slice = truncated ? buf.subarray(0, MAX_READ_BYTES) : buf;
      const contentType = metadata.mimeType || "application/octet-stream";
      const isText =
        contentType.startsWith("text/") ||
        contentType === "application/json" ||
        contentType.endsWith("+json") ||
        contentType.endsWith("+xml");

      return {
        metadata,
        contentType,
        text: isText ? slice.toString("utf8") : null,
        base64: isText ? null : slice.toString("base64"),
        byteLength: slice.byteLength,
        truncated,
      };
    } catch (err) {
      const status =
        (err as { status?: number; code?: number })?.status ??
        (err as { code?: number })?.code;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        status === 403 ||
        status === 404 ||
        /not found|insufficient|forbidden/i.test(msg)
      ) {
        throw httpError(
          403,
          "Provider denied read — file may be outside drive.file grants. Re-pick via Picker.",
        );
      }
      log.error("Files read failed", {
        providerFileId: metadata.providerFileId,
        error: msg,
      });
      throw httpError(502, "Failed to read file from provider");
    }
  }

  /** Authorize a principal against a drive_resource at a required role. */
  async authorize(
    driveResourceId: string,
    required: ObjectRole = "read",
  ): Promise<DriveResourceRow> {
    const principal = requireCurrentUserPrincipal();
    return authorizeBoundResource(principal, driveResourceId, required);
  }
}

export const filesApi = new FilesApi();
