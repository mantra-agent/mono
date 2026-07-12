import { Response } from "express";
import type { Principal } from "../principal";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { randomUUID } from "crypto";
import { createLogger } from "../log";
import {
  ObjectAclPolicy,
  ObjectPermission,
  canAccessObject,
  canAccessObjectForPrincipal,
  getObjectAclPolicy,
  setObjectAclPolicy,
} from "./objectAcl";
import {
  storageBackend,
  PUBLIC_PREFIX,
  PRIVATE_PREFIX,
  type ObjectMetadata,
} from "./s3-backend";
import {
  vaultObjectKeyFromPrincipal,
  isVaultKey,
  VAULT_PREFIX,
} from "./vault-keys";

const log = createLogger("ObjectStorage");

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

// An opaque handle to an object in the configured S3 bucket. Returned by
// `getObjectEntityFile` and `searchPublicObject`; exposes the small subset
// of methods the rest of the app uses (`download`, `getMetadata`, `exists`).
export class StorageObjectRef {
  constructor(
    public readonly key: string,
    private _metadata: ObjectMetadata | null = null,
  ) {}

  get name(): string {
    return this.key;
  }

  async getMetadata(): Promise<ObjectMetadata> {
    if (!this._metadata) {
      this._metadata = await storageBackend.getObjectMetadata(this.key);
    }
    return this._metadata;
  }

  async download(): Promise<[Buffer]> {
    const buf = await storageBackend.getObjectBuffer(this.key);
    return [buf];
  }

  async exists(): Promise<[boolean]> {
    const meta = await storageBackend.headObject(this.key);
    if (meta) this._metadata = meta;
    return [meta !== null];
  }
}

// Splits an object key like "private/abc-123" into its visibility prefix
// segment ("private/") and the entity id portion ("abc-123").
// For vault-prefixed keys like "vaults/{id}/uploads/abc.png", the entity portion
// is the path after the vault id (e.g. "uploads/abc.png").
function splitPrefix(key: string): { prefix: string; rest: string } | null {
  if (key.startsWith(PRIVATE_PREFIX)) {
    return { prefix: PRIVATE_PREFIX, rest: key.slice(PRIVATE_PREFIX.length) };
  }
  if (key.startsWith(PUBLIC_PREFIX)) {
    return { prefix: PUBLIC_PREFIX, rest: key.slice(PUBLIC_PREFIX.length) };
  }
  if (key.startsWith(VAULT_PREFIX)) {
    // vaults/{vaultId}/{entity...} → entity portion is after the vault id
    const afterVault = key.slice(VAULT_PREFIX.length);
    const slashIdx = afterVault.indexOf("/");
    if (slashIdx === -1) return null;
    const rest = afterVault.slice(slashIdx + 1);
    return { prefix: VAULT_PREFIX, rest };
  }
  return null;
}

// The object storage service is used to interact with the object storage service.
export class ObjectStorageService {
  constructor() {}

  // Returns the public key prefix used by the storage layout. Kept as an array
  // for backwards compatibility with the previous multi-search-path API.
  getPublicObjectSearchPaths(): Array<string> {
    return [PUBLIC_PREFIX];
  }

  // Returns the private key prefix used by the storage layout.
  getPrivateObjectDir(): string {
    return PRIVATE_PREFIX;
  }

  // Search for a public object under the public/ prefix.
  async searchPublicObject(filePath: string): Promise<StorageObjectRef | null> {
    const trimmed = filePath.replace(/^\/+/, "");
    const key = `${PUBLIC_PREFIX}${trimmed}`;
    const meta = await storageBackend.headObject(key);
    if (!meta) return null;
    return new StorageObjectRef(key, meta);
  }

  // Downloads an object to the response.
  async downloadObject(ref: StorageObjectRef, res: Response, cacheTtlSec: number = 3600, fileName?: string) {
    try {
      const metadata = await ref.getMetadata();
      const aclPolicy = await getObjectAclPolicy(ref.key);
      const isPublic = aclPolicy?.visibility === "public";
      const headers: Record<string, string> = {
        "Content-Type": metadata.contentType || "application/octet-stream",
        "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
      };
      if (typeof metadata.contentLength === "number") {
        headers["Content-Length"] = String(metadata.contentLength);
      }
      if (fileName) {
        headers["Content-Disposition"] = `attachment; filename="${fileName.replace(/"/g, '\\"')}"`;
      }
      res.set(headers);

      const stream = await storageBackend.getObjectStream(ref.key);
      stream.on("error", (err) => {
        log.error("Stream error:", err);
        if (!res.headersSent) {
          res.status(500).json({ error: "Error streaming file" });
        }
      });
      stream.pipe(res);
    } catch (error) {
      log.error("Error downloading file:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Error downloading file" });
      }
    }
  }

  async getObjectEntityUploadURL(
    extension?: string,
    opts: { owner?: string; ownerUserId?: string; accountId?: string; contentType?: string; prefix?: string; principal?: Principal | null } = {},
  ): Promise<string> {
    const objectId = randomUUID();
    const suffix = extension ? (extension.startsWith(".") ? extension : `.${extension}`) : "";
    const category = opts.prefix?.replace(/^\/+|\/+$/g, "") || "uploads";
    const filename = `${objectId}${suffix}`;

    // Resolve vault-prefixed key from principal
    const principal = opts.principal ?? getCurrentPrincipalOrSystem();
    const key = vaultObjectKeyFromPrincipal(principal, category, filename);

    if (opts.owner || opts.ownerUserId || opts.accountId) {
      await setObjectAclPolicy(key, {
        owner: opts.ownerUserId ?? opts.owner ?? "system",
        ownerUserId: opts.ownerUserId ?? opts.owner ?? null,
        accountId: opts.accountId ?? null,
        scope: opts.ownerUserId ? "user" : "system",
        visibility: "private",
        vaultId: principal.activeVaultId ?? undefined,
      });
    }
    return storageBackend.getSignedPutUrl(key, { ttlSec: 900, contentType: opts.contentType });
  }

  // Writes bytes directly to object storage through the canonical vault-aware
  // key path, records the ACL on the actual key, and verifies the write before
  // returning the `/objects/<category>/<filename>` entity path. This is the
  // single server-side upload boundary: it throws on any failure so callers
  // never hand out entity paths that were not durably persisted.
  async uploadObjectEntity(
    body: Buffer | string,
    opts: {
      extension?: string;
      contentType?: string;
      category?: string;
      acl?: Omit<ObjectAclPolicy, "vaultId">;
      principal?: Principal | null;
    } = {},
  ): Promise<{ objectPath: string; objectKey: string; size: number }> {
    const principal = opts.principal ?? getCurrentPrincipalOrSystem();
    const suffix = opts.extension
      ? opts.extension.startsWith(".")
        ? opts.extension
        : `.${opts.extension}`
      : "";
    const category = opts.category?.replace(/^\/+|\/+$/g, "") || "uploads";
    const filename = `${randomUUID()}${suffix}`;
    const objectKey = vaultObjectKeyFromPrincipal(principal, category, filename);
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf-8");

    await storageBackend.putObject(objectKey, buffer, { contentType: opts.contentType });

    if (opts.acl) {
      await setObjectAclPolicy(objectKey, {
        ...opts.acl,
        vaultId: principal?.activeVaultId ?? undefined,
      });
    }

    const meta = await storageBackend.headObject(objectKey);
    if (!meta) {
      throw new Error(`Object storage write verification failed: ${objectKey} not found after upload`);
    }
    if (typeof meta.contentLength === "number" && meta.contentLength !== buffer.length) {
      throw new Error(
        `Object storage write verification failed: ${objectKey} size mismatch (expected ${buffer.length} bytes, got ${meta.contentLength})`,
      );
    }

    log.info(`uploadObjectEntity: persisted ${buffer.length} bytes to ${objectKey}`);
    return { objectPath: `/objects/${category}/${filename}`, objectKey, size: buffer.length };
  }

  // Gets the object entity file from the object path.
  // Supports dual-read: tries vault-prefixed key first (if principal has activeVaultId),
  // then falls back to legacy private/ key.
  async getObjectEntityFile(objectPath: string, principal?: Principal | null): Promise<StorageObjectRef> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const entityId = objectPath.slice("/objects/".length);
    if (!entityId) {
      throw new ObjectNotFoundError();
    }

    // Resolve principal for vault-aware lookup
    const resolvedPrincipal = principal ?? getCurrentPrincipalOrSystem();
    const vaultId = resolvedPrincipal?.activeVaultId;

    // Try vault-prefixed key first
    if (vaultId) {
      const vaultKey = `${VAULT_PREFIX}${vaultId}/${entityId}`;
      const vaultMeta = await storageBackend.headObject(vaultKey);
      if (vaultMeta) {
        return new StorageObjectRef(vaultKey, vaultMeta);
      }
    }

    // Fall back to legacy key
    const legacyKey = `${PRIVATE_PREFIX}${entityId}`;
    const legacyMeta = await storageBackend.headObject(legacyKey);
    if (!legacyMeta) {
      throw new ObjectNotFoundError();
    }
    return new StorageObjectRef(legacyKey, legacyMeta);
  }

  // Rewrites an absolute storage URL (e.g. a presigned PUT URL the client
  // uploaded against, or a path-style bucket URL) into our `/objects/<id>`
  // entity contract. Other inputs are returned unchanged.
  normalizeObjectEntityPath(rawPath: string): string {
    if (!rawPath) return rawPath;

    let url: URL | null = null;
    if (/^https?:\/\//i.test(rawPath)) {
      try {
        url = new URL(rawPath);
      } catch {
        return rawPath;
      }
    }
    if (!url) return rawPath;

    const bucket = storageBackend.getBucketName();
    const endpointHost = storageBackend.getEndpointHost();
    const host = url.host.toLowerCase();

    const isHostMatch =
      (endpointHost && (host === endpointHost || host.endsWith(`.${endpointHost}`))) ||
      host.endsWith(".s3.amazonaws.com") ||
      host === "s3.amazonaws.com" ||
      /\.s3[.-][a-z0-9-]+\.amazonaws\.com$/i.test(host) ||
      host.endsWith(".r2.cloudflarestorage.com") ||
      host.endsWith(".backblazeb2.com");

    if (!isHostMatch) {
      return rawPath;
    }

    // Strip leading slash
    let path = url.pathname.replace(/^\/+/, "");

    // If the bucket is in the path (path-style), strip it.
    if (path.startsWith(`${bucket}/`)) {
      path = path.slice(bucket.length + 1);
    } else if (path === bucket) {
      path = "";
    }

    const split = splitPrefix(path);
    if (!split) {
      return rawPath;
    }
    if (split.prefix !== PRIVATE_PREFIX && split.prefix !== VAULT_PREFIX) {
      // We only mint /objects/ paths for private/vault entities.
      return rawPath;
    }
    return `/objects/${split.rest}`;
  }

  // Tries to set the ACL policy for the object entity and return the normalized path.
  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy,
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }

    const ref = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(ref.key, aclPolicy);
    return normalizedPath;
  }

  // Checks if the user can access the object entity.
  async canAccessObjectEntity({
    userId,
    principal,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    principal?: Principal | null;
    objectFile: StorageObjectRef;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    if (principal) {
      return canAccessObjectForPrincipal({
        principal,
        objectKey: objectFile.key,
        requestedPermission: requestedPermission ?? ObjectPermission.READ,
      });
    }
    return canAccessObject({
      userId,
      objectKey: objectFile.key,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}

export const objectStorageService = new ObjectStorageService();
export { storageBackend, PUBLIC_PREFIX, PRIVATE_PREFIX };
