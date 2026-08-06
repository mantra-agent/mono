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
 * Fail closed on disconnect, missing drive.readonly, or non-whitelist. Never ambient crawl.
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
  extractOfficeText,
  isExtractableOfficeMime,
} from "./file-text-extraction";
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

/** Inline tool-return preview cap — not a product/download ceiling. */
const MAX_INLINE_READ_BYTES = 2 * 1024 * 1024;
/** Text returned inline when the full staged body is this small or smaller. */
const MAX_INLINE_TEXT_CHARS = 100_000;
/** Bump when archive payload encoding/encryption changes so old keys miss cleanly. */
const DRIVE_FILE_CACHE_SCHEMA = "enc1";
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

export interface FilesReadArchiveRef {
  id: string;
  objectStoragePath: string;
  /** Decrypted/paginated body size in characters (utf-8 text or base64 text). */
  byteCount: number;
  reused: boolean;
  operationKey: string;
  /** How the archived body is encoded after decrypt. */
  encoding: "utf8" | "base64";
  /** Always AES-GCM envelope at rest for drive_file archives. */
  encryption: "aes-256-gcm";
  /** How to page the whole body. */
  retrieval: {
    tool: "indexed_content";
    get: "indexed_content.get";
    readSection: "indexed_content.read_section";
  };
}

export interface FilesReadResult {
  metadata: FilesMetadata;
  contentType: string;
  /** Inline text preview when small and text-like; otherwise null — use archive. */
  text: string | null;
  /** Inline base64 only for small binaries; large bodies are archived. */
  base64: string | null;
  /**
   * Provider-reported source size when known (metadata.size), else staged bytes.
   * Prefer sourceBytes for "how big is the file?"
   */
  sourceBytes: number | null;
  /** Bytes actually staged from the provider body (full file — no stage ceiling). */
  stagedBytes: number;
  /** Alias of stagedBytes for older callers. */
  byteLength: number;
  /** True only if a caller-supplied maxBytes cap cut the body. Never a product ceiling. */
  truncated: boolean;
  /** True when stagedBytes holds the full provider body (always true without a caller cap). */
  complete: boolean;
  /**
   * Next retrieval step when the body is not fully inline.
   * null when complete body is already inline in text/base64.
   */
  next: {
    tool: "indexed_content";
    id: string;
    actions: Array<"get" | "read_section">;
    encoding: "utf8" | "base64";
  } | null;
  /** Object-storage archive with sectioned/paginated access via indexed_content. */
  archive: FilesReadArchiveRef | null;
  /** hit = served from fingerprint cache without re-download; miss = freshly staged; none = archive unavailable. */
  cache: "hit" | "miss" | "none";
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
        "Drive access unavailable — reconnect Google for recursive read access, then reselect folders",
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

  const visited = new Set<string>([providerFileId]);
  let frontier = [providerFileId];

  for (let depth = 0; depth < MAX_PARENT_WALK && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const current of frontier) {
      const parents = await adapter.getParentIds(ctx, current);
      for (const parent of parents) {
        if (folderBindIds.has(parent)) return true;
        if (!visited.has(parent)) {
          visited.add(parent);
          next.push(parent);
        }
      }
    }
    frontier = next;
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

/**
 * Expected post-export content type for cache keys — must match adapter export map
 * so a Docs→text/plain cache entry is not reused as the native editor blob.
 */
function expectedReadContentType(sourceMime: string | null | undefined): string {
  if (!sourceMime) return "application/octet-stream";
  switch (sourceMime) {
    case "application/vnd.google-apps.document":
    case "application/vnd.google-apps.presentation":
      return "text/plain";
    case "application/vnd.google-apps.spreadsheet":
      return "text/csv";
    case "application/vnd.google-apps.drawing":
      return "image/png";
    default:
      return sourceMime;
  }
}

/**
 * Source-fingerprint operation key. md5 preferred; modifiedTime fallback.
 * When either changes, the key changes → cache miss → re-download.
 */
export function buildDriveFileCacheKey(input: {
  provider: string;
  providerFileId: string;
  md5Checksum?: string | null;
  modifiedTime?: string | null;
  contentType: string;
  encoding: "utf8" | "base64";
}): string {
  const version =
    (typeof input.md5Checksum === "string" && input.md5Checksum.trim()) ||
    (typeof input.modifiedTime === "string" && input.modifiedTime.trim()) ||
    "unversioned";
  return `drive-file:${input.provider}:${input.providerFileId}:v=${version}:ct=${input.contentType}:enc=${input.encoding}:${DRIVE_FILE_CACHE_SCHEMA}`;
}

function archiveEncodingFor(contentType: string): "utf8" | "base64" {
  return isTextLike(contentType) ? "utf8" : "base64";
}

function parseSourceBytes(size: string | null | undefined): number | null {
  if (size == null || size === "") return null;
  const n = Number(size);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function toArchiveRef(
  row: {
    id: string;
    objectStoragePath: string;
    byteCount: number;
  },
  opts: { operationKey: string; reused: boolean; encoding: "utf8" | "base64" },
): FilesReadArchiveRef {
  return {
    id: row.id,
    objectStoragePath: row.objectStoragePath,
    byteCount: row.byteCount,
    reused: opts.reused,
    operationKey: opts.operationKey,
    encoding: opts.encoding,
    encryption: "aes-256-gcm",
    retrieval: {
      tool: "indexed_content",
      get: "indexed_content.get",
      readSection: "indexed_content.read_section",
    },
  };
}

async function lookupDriveFileArchive(
  operationKey: string,
  encoding: "utf8" | "base64",
): Promise<FilesReadArchiveRef | null> {
  const { db } = await import("./db");
  const { indexedContent } = await import("@shared/schema");
  const { combineWithSensitiveVisible } = await import("./sensitive-scope");
  const ownerColumns = {
    ownerUserId: indexedContent.ownerUserId,
    principalAccountId: indexedContent.principalAccountId,
    vaultId: indexedContent.vaultId,
  };
  const [existing] = await db
    .select()
    .from(indexedContent)
    .where(
      combineWithSensitiveVisible(
        ownerColumns,
        and(
          eq(indexedContent.sourceType, "drive_file"),
          eq(indexedContent.operationKey, operationKey),
        ),
      ),
    )
    .limit(1);
  if (!existing) return null;
  return toArchiveRef(existing, { operationKey, reused: true, encoding });
}

/**
 * Stage full Drive body under AES-GCM envelope in R2 + indexed_content row.
 * Does not use plaintext persistToObjectStorage.
 */
async function stageDriveFileArchive(opts: {
  content: string;
  sourceLabel: string;
  operationKey: string;
  objectFileName?: string;
  encoding: "utf8" | "base64";
}): Promise<FilesReadArchiveRef | null> {
  const { db } = await import("./db");
  const { indexedContent } = await import("@shared/schema");
  const { combineWithSensitiveVisible, sensitiveOwnershipValues } = await import(
    "./sensitive-scope"
  );
  const {
    persistEncryptedDriveFileToObjectStorage,
  } = await import("./content-indexer");
  const owner = sensitiveOwnershipValues();
  const ownerColumns = {
    ownerUserId: indexedContent.ownerUserId,
    principalAccountId: indexedContent.principalAccountId,
    vaultId: indexedContent.vaultId,
  };

  // Exact-once: reuse if another concurrent writer won the key.
  const [existing] = await db
    .select()
    .from(indexedContent)
    .where(
      combineWithSensitiveVisible(
        ownerColumns,
        and(
          eq(indexedContent.sourceType, "drive_file"),
          eq(indexedContent.operationKey, opts.operationKey),
        ),
      ),
    )
    .limit(1);
  if (existing) {
    return toArchiveRef(existing, {
      operationKey: opts.operationKey,
      reused: true,
      encoding: opts.encoding,
    });
  }

  const objectPath = await persistEncryptedDriveFileToObjectStorage(
    opts.content,
    opts.objectFileName,
  );
  if (!objectPath) return null;

  // Heuristic section map over the decrypted/paginated body encoding (utf8 or base64 text).
  const chunkSize = Math.max(1, Math.ceil(opts.content.length / 4));
  const sections =
    opts.content.length <= 2000
      ? [
          {
            title: "Full",
            byteOffset: 0,
            byteLength: opts.content.length,
            keyFacts: [] as string[],
          },
        ]
      : Array.from({ length: 4 }, (_, i) => {
          const start = i * chunkSize;
          const len = Math.min(chunkSize, opts.content.length - start);
          return {
            title: `Part ${i + 1}`,
            byteOffset: start,
            byteLength: Math.max(0, len),
            keyFacts: [] as string[],
          };
        }).filter((s) => s.byteLength > 0);

  const { randomUUID } = await import("crypto");
  const id = randomUUID();
  const byteCount = Buffer.byteLength(opts.content, "utf-8");
  const index = {
    sections,
    keyFacts: [
      `encoding=${opts.encoding}`,
      "encryption=aes-256-gcm",
      "retrieval=indexed_content.get|read_section",
    ],
    identifiers: [] as string[],
    totalChars: opts.content.length,
  };

  const [inserted] = await db
    .insert(indexedContent)
    .values({
      id,
      ...owner,
      sourceType: "drive_file",
      operationKey: opts.operationKey,
      sourceLabel: opts.sourceLabel,
      objectStoragePath: objectPath,
      byteCount,
      index,
    })
    .onConflictDoNothing()
    .returning();

  if (!inserted) {
    const [winner] = await db
      .select()
      .from(indexedContent)
      .where(
        combineWithSensitiveVisible(
          ownerColumns,
          and(
            eq(indexedContent.sourceType, "drive_file"),
            eq(indexedContent.operationKey, opts.operationKey),
          ),
        ),
      )
      .limit(1);
    if (winner) {
      return toArchiveRef(winner, {
        operationKey: opts.operationKey,
        reused: true,
        encoding: opts.encoding,
      });
    }
    return null;
  }

  return toArchiveRef(
    { id: inserted.id, objectStoragePath: inserted.objectStoragePath, byteCount: inserted.byteCount },
    { operationKey: opts.operationKey, reused: false, encoding: opts.encoding },
  );
}

function buildReadResult(input: {
  metadata: FilesMetadata;
  contentType: string;
  text: string | null;
  base64: string | null;
  stagedBytes: number;
  truncated: boolean;
  archive: FilesReadArchiveRef | null;
  cache: FilesReadResult["cache"];
  encoding: "utf8" | "base64";
}): FilesReadResult {
  const sourceBytes = parseSourceBytes(input.metadata.size);
  const fullyInline =
    (input.encoding === "utf8" &&
      typeof input.text === "string" &&
      input.text.length === input.stagedBytes &&
      !input.truncated) ||
    (input.encoding === "base64" &&
      typeof input.base64 === "string" &&
      // base64 length is not stagedBytes; stagedBytes is raw binary length
      input.base64.length > 0 &&
      input.stagedBytes <= MAX_INLINE_READ_BYTES &&
      !input.truncated);
  const complete = !input.truncated;
  const next =
    input.archive && !fullyInline
      ? {
          tool: "indexed_content" as const,
          id: input.archive.id,
          actions: ["get", "read_section"] as Array<"get" | "read_section">,
          encoding: input.encoding,
        }
      : null;
  return {
    metadata: input.metadata,
    contentType: input.contentType,
    text: input.text,
    base64: input.base64,
    sourceBytes,
    stagedBytes: input.stagedBytes,
    byteLength: input.stagedBytes,
    truncated: input.truncated,
    complete,
    next,
    archive: input.archive,
    cache: input.cache,
  };
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
   *
   * Large-file path (no product stage ceiling):
   * 1. Fingerprint source (md5 preferred, else modifiedTime) + encoding + schema.
   * 2. Cache hit → serve AES-GCM envelope archive from R2 without re-download.
   * 3. Cache miss → download the FULL provider body, envelope-encrypt, stage to
   *    vault-scoped R2 + indexed_content, return completeness contract + next handle.
   * 4. Newer source changes the fingerprint → automatic miss → re-download.
   *
   * Completeness contract always includes sourceBytes / stagedBytes / complete / next.
   * Agent pages via indexed_content.get + read_section (decrypt happens server-side).
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

    const contentType = expectedReadContentType(metadata.mimeType);
    const officeExtraction = isExtractableOfficeMime(contentType);
    const encoding = officeExtraction ? "utf8" : archiveEncodingFor(contentType);
    const operationKey = buildDriveFileCacheKey({
      provider: metadata.provider,
      providerFileId: metadata.providerFileId,
      md5Checksum: metadata.md5Checksum,
      modifiedTime: metadata.modifiedTime,
      contentType,
      encoding,
    });

    // Cache hit: skip provider download entirely.
    try {
      let cached = await lookupDriveFileArchive(operationKey, encoding);
      let cachedEncoding = encoding;
      if (!cached && officeExtraction) {
        const binaryOperationKey = buildDriveFileCacheKey({
          provider: metadata.provider,
          providerFileId: metadata.providerFileId,
          md5Checksum: metadata.md5Checksum,
          modifiedTime: metadata.modifiedTime,
          contentType,
          encoding: "base64",
        });
        cached = await lookupDriveFileArchive(binaryOperationKey, "base64");
        cachedEncoding = "base64";
      }
      if (cached) {
        log.log("Files read cache hit", {
          provider: metadata.provider,
          providerFileId: metadata.providerFileId,
          archiveId: cached.id,
          byteCount: cached.byteCount,
        });
        let text: string | null = null;
        let base64: string | null = null;
        if (cachedEncoding === "utf8" && cached.byteCount <= MAX_INLINE_TEXT_CHARS) {
          const { readFromObjectStorage } = await import("./content-indexer");
          text = await readFromObjectStorage(cached.objectStoragePath);
        } else if (
          cachedEncoding === "base64" &&
          cached.byteCount <= Math.ceil((MAX_INLINE_READ_BYTES * 4) / 3)
        ) {
          const { readFromObjectStorage } = await import("./content-indexer");
          const body = await readFromObjectStorage(cached.objectStoragePath);
          if (body != null) base64 = body;
        }
        // stagedBytes: prefer provider size; fall back to decoded archive length.
        const stagedFromSource = parseSourceBytes(metadata.size);
        const stagedBytes =
          stagedFromSource != null
            ? stagedFromSource
            : cachedEncoding === "base64"
              ? Math.floor((cached.byteCount * 3) / 4)
              : cached.byteCount;
        return buildReadResult({
          metadata,
          contentType,
          text,
          base64,
          stagedBytes,
          truncated: false,
          archive: cached,
          cache: "hit",
          encoding: cachedEncoding,
        });
      }
    } catch (err) {
      // Cache lookup is best-effort; fall through to provider download.
      log.warn("Files read cache lookup failed", {
        provider: metadata.provider,
        providerFileId: metadata.providerFileId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    const { adapter, ctx } = await adapterContextForConnector(
      metadata.provider,
      metadata.connectedAccountId,
    );

    try {
      // No product ceiling — download the whole provider body.
      const bytes = await adapter.readBytes(ctx, metadata.providerFileId, {
        maxBytes: null,
        mimeType: metadata.mimeType,
      });

      const buf = bytes.buffer;
      const truncated = !!bytes.truncated;
      const resolvedContentType = officeExtraction
        ? contentType
        : bytes.contentType || contentType || metadata.mimeType || "application/octet-stream";
      let resolvedEncoding = archiveEncodingFor(resolvedContentType);
      let archiveBody: string;
      if (officeExtraction) {
        try {
          const extracted = await extractOfficeText(buf, resolvedContentType);
          if (extracted == null) {
            throw new Error("Office extraction exceeded limits or produced no text");
          }
          resolvedEncoding = "utf8";
          archiveBody = extracted;
        } catch (err) {
          log.warn("Office text extraction failed; preserving binary archive", {
            provider: metadata.provider,
            providerFileId: metadata.providerFileId,
            mimeType: resolvedContentType,
            sourceBytes: buf.length,
            err: err instanceof Error ? err.message.slice(0, 240) : "unknown",
          });
          resolvedEncoding = "base64";
          archiveBody = buf.toString("base64");
        }
      } else {
        archiveBody =
          resolvedEncoding === "utf8" ? buf.toString("utf8") : buf.toString("base64");
      }
      const safeName = (metadata.name || "file")
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .slice(0, 80);
      const objectFileName = `${safeName || "file"}.${resolvedEncoding === "utf8" ? "txt" : "b64"}.enc.json`;

      // Recompute key if export content-type diverged from the pre-download guess.
      const stageOperationKey =
        resolvedContentType === contentType && resolvedEncoding === encoding
          ? operationKey
          : buildDriveFileCacheKey({
              provider: metadata.provider,
              providerFileId: metadata.providerFileId,
              md5Checksum: metadata.md5Checksum,
              modifiedTime: metadata.modifiedTime,
              contentType: resolvedContentType,
              encoding: resolvedEncoding,
            });

      let archive: FilesReadArchiveRef | null = null;
      let cache: FilesReadResult["cache"] = "none";
      try {
        archive = await stageDriveFileArchive({
          content: archiveBody,
          sourceLabel: `${metadata.provider}:${metadata.name || metadata.providerFileId}`,
          operationKey: stageOperationKey,
          objectFileName,
          encoding: resolvedEncoding,
        });
        if (archive) cache = archive.reused ? "hit" : "miss";
      } catch (err) {
        log.warn("Files read archive stage failed", {
          provider: metadata.provider,
          providerFileId: metadata.providerFileId,
          err: err instanceof Error ? err.message : String(err),
        });
      }

      // Inline preview only — full body always lives in the archive when staged.
      let text: string | null = null;
      let base64: string | null = null;
      if (resolvedEncoding === "utf8") {
        text =
          archiveBody.length <= MAX_INLINE_TEXT_CHARS
            ? archiveBody
            : archiveBody.slice(0, MAX_INLINE_TEXT_CHARS);
      } else if (buf.length <= MAX_INLINE_READ_BYTES) {
        base64 = buf.toString("base64");
      }

      return buildReadResult({
        metadata,
        contentType: resolvedContentType,
        text,
        base64,
        stagedBytes: buf.length,
        truncated,
        archive,
        cache,
        encoding: resolvedEncoding,
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 403 || status === 404 || status === 501) throw err;
      // Provider authorization and stale/deleted IDs can surface as 403 or 404.
      const msg = err instanceof Error ? err.message : String(err);
      if (/403|insufficient|not found|404/i.test(msg)) {
        throw httpError(
          403,
          "Provider denied read — reconnect Google or reselect the bound root.",
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
