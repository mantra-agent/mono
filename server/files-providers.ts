/**
 * Files provider adapters — transport only.
 *
 * FilesApi remains the single enforcement boundary:
 *   vault gate → bind / ownership / grant → whitelist → adapter call
 *
 * Adapters never authorize. They receive an already-authorized owner token
 * (or null for Mantra/Box) and talk to the provider. Fail closed.
 */
import { google } from "googleapis";
import { createLogger } from "./log";
import {
  ObjectNotFoundError,
  StorageObjectRef,
  objectStorageService,
  PRIVATE_PREFIX,
} from "./object_storage";
import {
  extractEntityPath,
  isLegacyKey,
  isVaultKey,
} from "./object_storage/vault-keys";

const log = createLogger("FilesProviders");

export type FilesProvider = "google" | "box" | "mantra";

export const FILES_PROVIDERS: readonly FilesProvider[] = [
  "google",
  "box",
  "mantra",
] as const;

export function isFilesProvider(value: string): value is FilesProvider {
  return (FILES_PROVIDERS as readonly string[]).includes(value);
}

export interface AdapterContext {
  connectedAccountId: string;
  /** OAuth access token for Google; null for Mantra/Box. */
  accessToken: string | null;
}

export interface AdapterMetadata {
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
}

export interface AdapterChild {
  provider: FilesProvider;
  providerFileId: string;
  name: string;
  mimeType: string | null;
  resourceType: "file" | "folder";
  iconUrl: string | null;
  webViewLink: string | null;
}

export interface AdapterBytes {
  buffer: Buffer;
  contentType: string;
  byteLength: number;
  truncated: boolean;
  /** Source mime (pre-export) when different from contentType. */
  sourceMimeType?: string | null;
  name?: string;
  iconUrl?: string | null;
  webViewLink?: string | null;
  size?: string | null;
  modifiedTime?: string | null;
  md5Checksum?: string | null;
}

export interface FilesProviderAdapter {
  readonly provider: FilesProvider;
  getMetadata(ctx: AdapterContext, providerFileId: string): Promise<AdapterMetadata>;
  listChildren(
    ctx: AdapterContext,
    opts: { folderId: string; pageToken?: string; pageSize?: number },
  ): Promise<{ children: AdapterChild[]; nextPageToken: string | null }>;
  /**
   * Read raw/export bytes. Google editors are exported to text/csv.
   * maxBytes caps the returned buffer; truncated=true when more existed.
   */
  readBytes(
    ctx: AdapterContext,
    providerFileId: string,
    opts: { maxBytes: number; mimeType?: string | null },
  ): Promise<AdapterBytes>;
  /** Parent provider ids for whitelist ancestry walks. Empty = root/orphan. */
  getParentIds(ctx: AdapterContext, providerFileId: string): Promise<string[]>;
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_EXPORT_MAP: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": {
    mime: "text/plain",
    ext: "txt",
  },
  "application/vnd.google-apps.spreadsheet": {
    mime: "text/csv",
    ext: "csv",
  },
  "application/vnd.google-apps.presentation": {
    mime: "text/plain",
    ext: "txt",
  },
  "application/vnd.google-apps.drawing": {
    mime: "image/png",
    ext: "png",
  },
};

// ── Google Drive ────────────────────────────────────────────────────────────

class GoogleDriveAdapter implements FilesProviderAdapter {
  readonly provider: FilesProvider = "google";

  private drive(ctx: AdapterContext) {
    if (!ctx.accessToken) {
      throw httpError(403, "Google Drive access token missing");
    }
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: ctx.accessToken });
    return google.drive({ version: "v3", auth });
  }

  async getMetadata(
    ctx: AdapterContext,
    providerFileId: string,
  ): Promise<AdapterMetadata> {
    const drive = this.drive(ctx);
    try {
      const res = await drive.files.get({
        fileId: providerFileId,
        fields:
          "id,name,mimeType,iconLink,webViewLink,size,modifiedTime,md5Checksum,parents,trashed",
        supportsAllDrives: true,
      });
      const f = res.data;
      if (!f.id) throw httpError(404, "Google file not found");
      if (f.trashed) throw httpError(404, "Google file is trashed");
      const mimeType = f.mimeType ?? null;
      return {
        provider: "google",
        providerFileId: f.id,
        name: f.name ?? f.id,
        mimeType,
        resourceType: mimeType === GOOGLE_FOLDER_MIME ? "folder" : "file",
        iconUrl: f.iconLink ?? null,
        webViewLink: f.webViewLink ?? null,
        size: f.size ?? null,
        modifiedTime: f.modifiedTime ?? null,
        md5Checksum: f.md5Checksum ?? null,
      };
    } catch (err) {
      rethrowProvider(err, "Google Drive metadata");
    }
  }

  async listChildren(
    ctx: AdapterContext,
    opts: { folderId: string; pageToken?: string; pageSize?: number },
  ): Promise<{ children: AdapterChild[]; nextPageToken: string | null }> {
    const drive = this.drive(ctx);
    try {
      const res = await drive.files.list({
        q: `'${opts.folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
        pageSize: Math.min(Math.max(opts.pageSize ?? 50, 1), 100),
        pageToken: opts.pageToken,
        fields:
          "nextPageToken, files(id,name,mimeType,iconLink,webViewLink,size,modifiedTime)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      const children: AdapterChild[] = (res.data.files ?? [])
        .filter((f): f is typeof f & { id: string } => Boolean(f.id))
        .map((f) => {
          const mimeType = f.mimeType ?? null;
          return {
            provider: "google" as const,
            providerFileId: f.id,
            name: f.name ?? f.id,
            mimeType,
            resourceType:
              mimeType === GOOGLE_FOLDER_MIME
                ? ("folder" as const)
                : ("file" as const),
            iconUrl: f.iconLink ?? null,
            webViewLink: f.webViewLink ?? null,
          };
        });
      return {
        children,
        nextPageToken: res.data.nextPageToken ?? null,
      };
    } catch (err) {
      rethrowProvider(err, "Google Drive list");
    }
  }

  async readBytes(
    ctx: AdapterContext,
    providerFileId: string,
    opts: { maxBytes: number; mimeType?: string | null },
  ): Promise<AdapterBytes> {
    const drive = this.drive(ctx);
    try {
      // Refresh metadata when mime unknown so we can choose export vs media.
      let mimeType = opts.mimeType ?? null;
      let name: string | undefined;
      let iconUrl: string | null | undefined;
      let webViewLink: string | null | undefined;
      let size: string | null | undefined;
      let modifiedTime: string | null | undefined;
      let md5Checksum: string | null | undefined;

      if (!mimeType) {
        const meta = await this.getMetadata(ctx, providerFileId);
        if (meta.resourceType === "folder") {
          throw httpError(400, "Cannot read a folder");
        }
        mimeType = meta.mimeType;
        name = meta.name;
        iconUrl = meta.iconUrl;
        webViewLink = meta.webViewLink;
        size = meta.size;
        modifiedTime = meta.modifiedTime;
        md5Checksum = meta.md5Checksum;
      }

      if (mimeType === GOOGLE_FOLDER_MIME) {
        throw httpError(400, "Cannot read a folder");
      }

      const exportSpec = mimeType ? GOOGLE_EXPORT_MAP[mimeType] : undefined;
      let buffer: Buffer;
      let contentType: string;

      if (exportSpec) {
        const res = await drive.files.export(
          { fileId: providerFileId, mimeType: exportSpec.mime },
          { responseType: "arraybuffer" },
        );
        buffer = Buffer.from(res.data as ArrayBuffer);
        contentType = exportSpec.mime;
      } else {
        const res = await drive.files.get(
          {
            fileId: providerFileId,
            alt: "media",
            supportsAllDrives: true,
          },
          { responseType: "arraybuffer" },
        );
        buffer = Buffer.from(res.data as ArrayBuffer);
        contentType = mimeType || "application/octet-stream";
      }

      const truncated = buffer.length > opts.maxBytes;
      if (truncated) {
        buffer = buffer.subarray(0, opts.maxBytes);
      }

      return {
        buffer,
        contentType,
        byteLength: buffer.length,
        truncated,
        sourceMimeType: mimeType,
        name,
        iconUrl,
        webViewLink,
        size,
        modifiedTime,
        md5Checksum,
      };
    } catch (err) {
      rethrowProvider(err, "Google Drive read");
    }
  }

  async getParentIds(
    ctx: AdapterContext,
    providerFileId: string,
  ): Promise<string[]> {
    const drive = this.drive(ctx);
    try {
      const res = await drive.files.get({
        fileId: providerFileId,
        fields: "parents,trashed",
        supportsAllDrives: true,
      });
      if (res.data.trashed) return [];
      return (res.data.parents ?? []).filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      );
    } catch (err) {
      // Missing/denied files are not under any bind.
      const status = (err as { code?: number; status?: number }).code
        ?? (err as { status?: number }).status;
      if (status === 404 || status === 403) return [];
      rethrowProvider(err, "Google Drive parents");
    }
  }
}

// ── Box (stub) ──────────────────────────────────────────────────────────────

class BoxAdapter implements FilesProviderAdapter {
  readonly provider: FilesProvider = "box";

  private notConfigured(): never {
    throw httpError(
      501,
      "Box provider is not configured — Box OAuth is not connected yet",
    );
  }

  async getMetadata(
    _ctx: AdapterContext,
    _providerFileId: string,
  ): Promise<AdapterMetadata> {
    this.notConfigured();
  }

  async listChildren(
    _ctx: AdapterContext,
    _opts: { folderId: string; pageToken?: string; pageSize?: number },
  ): Promise<{ children: AdapterChild[]; nextPageToken: string | null }> {
    this.notConfigured();
  }

  async readBytes(
    _ctx: AdapterContext,
    _providerFileId: string,
    _opts: { maxBytes: number; mimeType?: string | null },
  ): Promise<AdapterBytes> {
    this.notConfigured();
  }

  async getParentIds(
    _ctx: AdapterContext,
    _providerFileId: string,
  ): Promise<string[]> {
    this.notConfigured();
  }
}

// ── Mantra object storage ───────────────────────────────────────────────────

/**
 * Mantra-native files live in persistent object storage (the same surface the
 * `files` tool write/read/list uses). providerFileId is an object key or
 * /objects/... entity path. No ambient crawl — only the bound key is readable.
 *
 * Authorization is FilesApi's job; this adapter only fetches bytes/metadata
 * under a system-elevated call path already gated by bind/grant.
 */
class MantraStorageAdapter implements FilesProviderAdapter {
  readonly provider: FilesProvider = "mantra";

  /**
   * Resolve providerFileId to a StorageObjectRef.
   * Accepts /objects/... paths (files tool), vault/legacy keys, or bare entity ids.
   */
  private async refFor(providerFileId: string): Promise<StorageObjectRef> {
    const raw = providerFileId.trim();
    if (!raw) throw httpError(400, "Empty Mantra providerFileId");

    try {
      // Entity path form used by the files tool / object routes.
      if (
        raw.startsWith("/objects/") ||
        raw.startsWith("objects/") ||
        (!isVaultKey(raw) &&
          !isLegacyKey(raw) &&
          !raw.startsWith(PRIVATE_PREFIX) &&
          !raw.includes("/"))
      ) {
        const objectPath = raw.startsWith("/")
          ? raw
          : raw.startsWith("objects/")
            ? `/${raw}`
            : `/objects/${raw}`;
        try {
          return await objectStorageService.getObjectEntityFile(objectPath);
        } catch (err) {
          if (!(err instanceof ObjectNotFoundError)) throw err;
          // Fall through to direct key lookup.
        }
      }

      // Direct storage key (vaults/... or private/... or legacy uploads/...).
      let key = raw;
      if (raw.startsWith("/objects/") || raw.startsWith("objects/")) {
        const normalized = objectStorageService.normalizeObjectEntityPath(
          raw.startsWith("/") ? raw : `/${raw}`,
        );
        // normalizeObjectEntityPath returns /objects/... — strip to storage key.
        key = normalized.replace(/^\/objects\//, PRIVATE_PREFIX);
      }

      const direct = new StorageObjectRef(key);
      const [directExists] = await direct.exists();
      if (directExists) return direct;

      // Try private-prefix form if bare entity path.
      const entity = extractEntityPath(key);
      if (entity) {
        const privateRef = new StorageObjectRef(`${PRIVATE_PREFIX}${entity}`);
        const [privateExists] = await privateRef.exists();
        if (privateExists) return privateRef;
      }
      throw httpError(404, "Mantra file not found");
    } catch (err) {
      if ((err as { status?: number }).status) throw err;
      if (err instanceof ObjectNotFoundError) {
        throw httpError(404, "Mantra file not found");
      }
      log.error("Mantra storage resolve failed", {
        providerFileId,
        err: err instanceof Error ? err.message : String(err),
      });
      throw httpError(502, "Mantra storage resolve failed");
    }
  }

  async getMetadata(
    _ctx: AdapterContext,
    providerFileId: string,
  ): Promise<AdapterMetadata> {
    const ref = await this.refFor(providerFileId);
    try {
      const meta = await ref.getMetadata();
      const name =
        providerFileId.split("/").filter(Boolean).pop() || ref.key;
      return {
        provider: "mantra",
        providerFileId,
        name,
        mimeType: meta.contentType ?? "application/octet-stream",
        resourceType: "file",
        iconUrl: null,
        webViewLink: null,
        size:
          meta.contentLength != null ? String(meta.contentLength) : null,
        modifiedTime:
          meta.lastModified != null
            ? new Date(meta.lastModified).toISOString()
            : null,
        md5Checksum: meta.etag ?? null,
      };
    } catch (err) {
      if ((err as { status?: number }).status) throw err;
      if (err instanceof ObjectNotFoundError) {
        throw httpError(404, "Mantra file not found");
      }
      throw httpError(502, "Mantra metadata failed");
    }
  }

  async listChildren(
    _ctx: AdapterContext,
    _opts: { folderId: string; pageToken?: string; pageSize?: number },
  ): Promise<{ children: AdapterChild[]; nextPageToken: string | null }> {
    // Object storage has no folder hierarchy in v1. Folder binds are not
    // listable via ambient prefix crawl — fail closed.
    throw httpError(
      400,
      "Mantra storage does not support folder listing — bind files explicitly",
    );
  }

  async readBytes(
    _ctx: AdapterContext,
    providerFileId: string,
    opts: { maxBytes: number; mimeType?: string | null },
  ): Promise<AdapterBytes> {
    const ref = await this.refFor(providerFileId);
    try {
      const [buf] = await ref.download();
      const meta = await ref.getMetadata().catch(() => null);
      const truncated = buf.length > opts.maxBytes;
      const buffer = truncated ? buf.subarray(0, opts.maxBytes) : buf;
      const contentType =
        meta?.contentType ||
        opts.mimeType ||
        "application/octet-stream";
      return {
        buffer,
        contentType,
        byteLength: buffer.length,
        truncated,
        sourceMimeType: meta?.contentType ?? opts.mimeType ?? null,
        name: providerFileId.split("/").filter(Boolean).pop(),
        size:
          meta?.contentLength != null ? String(meta.contentLength) : null,
        modifiedTime:
          meta?.lastModified != null
            ? new Date(meta.lastModified).toISOString()
            : null,
        md5Checksum: meta?.etag ?? null,
      };
    } catch (err) {
      if ((err as { status?: number }).status) throw err;
      if (err instanceof ObjectNotFoundError) {
        throw httpError(404, "Mantra file not found");
      }
      log.error("Mantra read failed", {
        providerFileId,
        err: err instanceof Error ? err.message : String(err),
      });
      throw httpError(502, "Mantra storage read failed");
    }
  }

  async getParentIds(
    _ctx: AdapterContext,
    _providerFileId: string,
  ): Promise<string[]> {
    // Flat object keys — no parent walk. Whitelist is explicit file binds only.
    return [];
  }
}

// ── Registry ────────────────────────────────────────────────────────────────

const adapters: Record<FilesProvider, FilesProviderAdapter> = {
  google: new GoogleDriveAdapter(),
  box: new BoxAdapter(),
  mantra: new MantraStorageAdapter(),
};

export function getFilesProviderAdapter(provider: string): FilesProviderAdapter {
  if (!isFilesProvider(provider)) {
    throw httpError(400, `Unknown files provider: ${provider}`);
  }
  return adapters[provider];
}

function rethrowProvider(err: unknown, label: string): never {
  if ((err as { status?: number }).status) throw err;
  const anyErr = err as {
    code?: number | string;
    status?: number;
    message?: string;
    errors?: Array<{ message?: string }>;
    response?: { status?: number };
  };
  const status =
    anyErr.status ??
    anyErr.response?.status ??
    (typeof anyErr.code === "number" ? anyErr.code : undefined);
  const message =
    anyErr.errors?.[0]?.message ||
    anyErr.message ||
    `${label} failed`;

  if (status === 404) throw httpError(404, message);
  if (status === 403) {
    throw httpError(
      403,
      "Provider denied access — file may be outside grants. Re-pick via Picker.",
    );
  }
  if (status === 401) {
    throw httpError(403, "Provider auth failed — reconnect the account");
  }
  log.error(label, { err: message, status });
  throw httpError(502, `${label} failed`);
}


