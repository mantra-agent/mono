import { Response } from "express";
import type { Principal } from "../principal";
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
function splitPrefix(key: string): { prefix: string; rest: string } | null {
  if (key.startsWith(PRIVATE_PREFIX)) {
    return { prefix: PRIVATE_PREFIX, rest: key.slice(PRIVATE_PREFIX.length) };
  }
  if (key.startsWith(PUBLIC_PREFIX)) {
    return { prefix: PUBLIC_PREFIX, rest: key.slice(PUBLIC_PREFIX.length) };
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
    opts: { owner?: string; ownerUserId?: string; accountId?: string; contentType?: string; prefix?: string } = {},
  ): Promise<string> {
    const objectId = randomUUID();
    const suffix = extension ? (extension.startsWith(".") ? extension : `.${extension}`) : "";
    const prefix = opts.prefix?.replace(/^\/+|\/+$/g, "") || "uploads";
    const key = `${PRIVATE_PREFIX}${prefix}/${objectId}${suffix}`;
    if (opts.owner || opts.ownerUserId || opts.accountId) {
      await setObjectAclPolicy(key, {
        owner: opts.ownerUserId ?? opts.owner ?? "system",
        ownerUserId: opts.ownerUserId ?? opts.owner ?? null,
        accountId: opts.accountId ?? null,
        scope: opts.ownerUserId ? "user" : "system",
        visibility: "private",
      });
    }
    return storageBackend.getSignedPutUrl(key, { ttlSec: 900, contentType: opts.contentType });
  }

  // Gets the object entity file from the object path.
  async getObjectEntityFile(objectPath: string): Promise<StorageObjectRef> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const entityId = objectPath.slice("/objects/".length);
    if (!entityId) {
      throw new ObjectNotFoundError();
    }

    const key = `${PRIVATE_PREFIX}${entityId}`;
    const meta = await storageBackend.headObject(key);
    if (!meta) {
      throw new ObjectNotFoundError();
    }
    return new StorageObjectRef(key, meta);
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
    if (split.prefix !== PRIVATE_PREFIX) {
      // We only mint /objects/ paths for private entities.
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
