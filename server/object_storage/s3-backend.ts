import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "stream";
import { getSecretSync, onSecretChange } from "../secrets-store";
import { createLogger } from "../log";
import { db } from "../db";
import { environmentCapabilityBindings } from "@shared/models/platforms";
import { eq, and } from "drizzle-orm";
import { decrypt, getEncryptionKey, getPreviousEncryptionKey, isEncryptedEnvelope } from "../encryption";

const log = createLogger("S3Backend");

export const PUBLIC_PREFIX = "public/";
export const PRIVATE_PREFIX = "private/";

const S3_SECRET_NAMES = [
  "S3_BUCKET",
  "S3_REGION",
  "S3_ENDPOINT",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_FORCE_PATH_STYLE",
] as const;

interface S3Config {
  bucket: string;
  region: string;
  endpoint: string | undefined;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

let _client: S3Client | null = null;
let _config: S3Config | null = null;
let _source: "binding" | "legacy" | null = null;

// Binding resolution cache — populated by warmStorageConfig()
let _bindingResolved = false;
let _bindingConfig: S3Config | null = null;

/**
 * Resolve object storage config from an active R2 capability binding.
 *
 * Looks for an enabled binding with capability_type='object_storage' and provider='cloudflare'.
 * The binding's config JSONB stores { bucket, accountId, region? }.
 * The binding's secret_envelope stores encrypted JSON { accessKeyId, secretAccessKey }.
 *
 * Returns null if no active binding exists or credentials can't be decrypted.
 */
async function resolveR2Binding(): Promise<S3Config | null> {
  try {
    const [binding] = await db
      .select()
      .from(environmentCapabilityBindings)
      .where(
        and(
          eq(environmentCapabilityBindings.capabilityType, "object_storage"),
          eq(environmentCapabilityBindings.provider, "cloudflare"),
          eq(environmentCapabilityBindings.enabled, true),
        ),
      )
      .limit(1);

    if (!binding) return null;

    const cfg = binding.config as Record<string, unknown> | null;
    if (!cfg) return null;

    const bucket = cfg.bucket as string | undefined;
    const accountId = cfg.accountId as string | undefined;
    if (!bucket || !accountId) {
      log.log("R2 binding found but missing bucket or accountId in config — skipping");
      return null;
    }

    // Decrypt S3-compatible credentials from secret_envelope
    if (!binding.secretEnvelope || !isEncryptedEnvelope(binding.secretEnvelope)) {
      log.log("R2 binding found but no encrypted secret — skipping");
      return null;
    }

    let secretJson: string;
    try {
      secretJson = await decrypt(binding.secretEnvelope, getEncryptionKey());
    } catch {
      // Try previous key in case of rotation
      const prevKey = getPreviousEncryptionKey();
      if (!prevKey) {
        log.log("R2 binding secret decryption failed and no previous key — skipping");
        return null;
      }
      try {
        secretJson = await decrypt(binding.secretEnvelope, prevKey);
      } catch {
        log.log("R2 binding secret decryption failed with both keys — skipping");
        return null;
      }
    }

    let keys: { accessKeyId?: string; secretAccessKey?: string };
    try {
      keys = JSON.parse(secretJson);
    } catch {
      log.log("R2 binding secret is not valid JSON — skipping");
      return null;
    }

    if (!keys.accessKeyId || !keys.secretAccessKey) {
      log.log("R2 binding secret missing accessKeyId or secretAccessKey — skipping");
      return null;
    }

    const region = (cfg.region as string) || "auto";
    const endpoint = (cfg.endpoint as string) || `https://${accountId}.r2.cloudflarestorage.com`;

    return {
      bucket,
      region,
      endpoint,
      accessKeyId: keys.accessKeyId,
      secretAccessKey: keys.secretAccessKey,
      forcePathStyle: true, // R2 S3-compat uses path-style
    };
  } catch (err) {
    log.log(`R2 binding resolution error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Warm storage config by resolving R2 capability binding from the database.
 * Call once during server startup. Safe to call again to re-resolve after
 * binding changes (upsert/delete).
 */
export async function warmStorageConfig(): Promise<void> {
  const config = await resolveR2Binding();
  _bindingConfig = config;
  _bindingResolved = true;
  // Clear cached client so getClient() picks up the new config
  _client = null;
  _config = null;
  _source = null;
  if (config) {
    log.log(`R2 binding resolved: bucket=${config.bucket} endpoint=${config.endpoint}`);
  } else {
    log.log("No R2 binding found — will use legacy S3 secrets");
  }
}

function loadLegacyConfig(): S3Config {
  const bucket = getSecretSync("S3_BUCKET");
  const region = getSecretSync("S3_REGION");
  const endpointRaw = getSecretSync("S3_ENDPOINT");
  const accessKeyId = getSecretSync("S3_ACCESS_KEY_ID");
  const secretAccessKey = getSecretSync("S3_SECRET_ACCESS_KEY");
  const forcePathStyleRaw = getSecretSync("S3_FORCE_PATH_STYLE");

  const missing: string[] = [];
  if (!bucket) missing.push("S3_BUCKET");
  if (!region) missing.push("S3_REGION");
  if (!accessKeyId) missing.push("S3_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("S3_SECRET_ACCESS_KEY");
  if (missing.length > 0) {
    throw new Error(
      `Object storage not configured — set the following secrets in Settings → Secrets: ${missing.join(", ")}`,
    );
  }

  const forcePathStyle = (forcePathStyleRaw || "").toLowerCase() === "true";
  const endpoint = endpointRaw && endpointRaw.length > 0 ? endpointRaw : undefined;

  return {
    bucket: bucket!,
    region: region!,
    endpoint,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    forcePathStyle,
  };
}

function buildClient(config: S3Config): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

function getClient(): { client: S3Client; config: S3Config } {
  if (_client && _config) {
    return { client: _client, config: _config };
  }

  // Use pre-resolved R2 binding if available
  if (_bindingResolved && _bindingConfig) {
    _config = _bindingConfig;
    _client = buildClient(_config);
    _source = "binding";
    log.log(`S3 client initialized from R2 binding: bucket=${_config.bucket} region=${_config.region} endpoint=${_config.endpoint || "(default)"}`);
    return { client: _client, config: _config };
  }

  // Fall back to legacy S3_* secrets
  _config = loadLegacyConfig();
  _client = buildClient(_config);
  _source = "legacy";
  log.log(`S3 client initialized from legacy secrets: bucket=${_config.bucket} region=${_config.region} endpoint=${_config.endpoint || "(default)"} pathStyle=${_config.forcePathStyle}`);
  return { client: _client, config: _config };
}

function resetClient(): void {
  _client = null;
  _config = null;
  _source = null;
}

onSecretChange((name) => {
  if ((S3_SECRET_NAMES as readonly string[]).includes(name)) {
    resetClient();
  }
});

export interface ObjectMetadata {
  contentType?: string;
  contentLength?: number;
  cacheControl?: string;
  lastModified?: Date;
  etag?: string;
}

export interface ListedObject {
  key: string;
  size: number;
  updatedAt: Date | undefined;
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number }; Code?: string };
  if (e.$metadata?.httpStatusCode === 404) return true;
  if (e.name === "NotFound" || e.name === "NoSuchKey") return true;
  if (e.Code === "NoSuchKey" || e.Code === "NotFound") return true;
  return false;
}

export const storageBackend = {
  getBucketName(): string {
    return getClient().config.bucket;
  },

  getEndpointHost(): string | null {
    const { config } = getClient();
    if (!config.endpoint) return null;
    try {
      return new URL(config.endpoint).host.toLowerCase();
    } catch {
      return null;
    }
  },

  isConfigured(): boolean {
    try {
      getClient();
      return true;
    } catch {
      return false;
    }
  },

  /** Returns the current config source: 'binding', 'legacy', or null if not yet initialized */
  getSource(): "binding" | "legacy" | null {
    return _source;
  },

  /** Reset the cached client, forcing re-resolution on next getClient() call */
  reset(): void {
    resetClient();
  },

  async headObject(key: string): Promise<ObjectMetadata | null> {
    const { client, config } = getClient();
    try {
      const out = await client.send(
        new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
      );
      return {
        contentType: out.ContentType,
        contentLength: typeof out.ContentLength === "number" ? out.ContentLength : undefined,
        cacheControl: out.CacheControl,
        lastModified: out.LastModified,
        etag: out.ETag,
      };
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  },

  async getObjectMetadata(key: string): Promise<ObjectMetadata> {
    const meta = await this.headObject(key);
    if (!meta) throw new Error(`Object not found: ${key}`);
    return meta;
  },

  async getObjectStream(key: string): Promise<Readable> {
    const { client, config } = getClient();
    const out = await client.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    );
    if (!out.Body) throw new Error(`Empty body for object ${key}`);
    return out.Body as Readable;
  },

  async getObjectBuffer(key: string): Promise<Buffer> {
    const stream = await this.getObjectStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  },

  async putObject(
    key: string,
    body: Buffer | Uint8Array | string | Readable,
    opts: { contentType?: string; cacheControl?: string } = {},
  ): Promise<void> {
    const { client, config } = getClient();
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body as PutObjectCommandInput["Body"],
        ContentType: opts.contentType,
        CacheControl: opts.cacheControl,
      }),
    );
  },

  async deleteObject(key: string): Promise<void> {
    const { client, config } = getClient();
    await client.send(
      new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
    );
  },

  async listObjects(prefix: string, opts: { maxKeys?: number } = {}): Promise<ListedObject[]> {
    const { client, config } = getClient();
    const results: ListedObject[] = [];
    let continuationToken: string | undefined;
    const maxKeys = opts.maxKeys;
    do {
      const out = await client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
          MaxKeys: maxKeys && maxKeys - results.length > 0 ? Math.min(1000, maxKeys - results.length) : undefined,
        }),
      );
      for (const obj of out.Contents || []) {
        if (!obj.Key) continue;
        results.push({
          key: obj.Key,
          size: typeof obj.Size === "number" ? obj.Size : 0,
          updatedAt: obj.LastModified,
        });
        if (maxKeys && results.length >= maxKeys) break;
      }
      continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
      if (maxKeys && results.length >= maxKeys) break;
    } while (continuationToken);
    return results;
  },

  async getSignedPutUrl(
    key: string,
    opts: { contentType?: string; ttlSec?: number } = {},
  ): Promise<string> {
    const { client, config } = getClient();
    const cmd = new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      ContentType: opts.contentType,
    });
    return getSignedUrl(client, cmd, { expiresIn: opts.ttlSec ?? 900 });
  },

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    const { client, config } = getClient();
    await client.send(
      new CopyObjectCommand({
        Bucket: config.bucket,
        CopySource: `${config.bucket}/${sourceKey}`,
        Key: destKey,
      }),
    );
  },

  async getSignedGetUrl(
    key: string,
    opts: { ttlSec?: number } = {},
  ): Promise<string> {
    const { client, config } = getClient();
    const cmd = new GetObjectCommand({ Bucket: config.bucket, Key: key });
    return getSignedUrl(client, cmd, { expiresIn: opts.ttlSec ?? 900 });
  },
};

export type StorageBackend = typeof storageBackend;
