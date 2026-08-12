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
  /**
   * Tree-local provider id (the id under the browsed parent). For Google
   * shortcuts this stays the shortcut id so whitelist ancestry can walk the
   * bound folder path.
   */
  providerFileId: string;
  /**
   * Id used for list/read/content operations after shortcut resolution.
   * Equals providerFileId when the item is not a shortcut.
   */
  contentProviderFileId: string;
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
  /** See AdapterMetadata.contentProviderFileId. */
  contentProviderFileId: string;
  name: string;
  mimeType: string | null;
  resourceType: "file" | "folder";
  iconUrl: string | null;
  webViewLink: string | null;
  /** Cheap discovery fingerprint when the provider returns it on list. */
  modifiedTime?: string | null;
  md5Checksum?: string | null;
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
   * maxBytes is optional — omit/null for the full body (no product ceiling).
   * truncated=true only when a finite maxBytes cap was applied.
   */
  readBytes(
    ctx: AdapterContext,
    providerFileId: string,
    opts: { maxBytes?: number | null; mimeType?: string | null },
  ): Promise<AdapterBytes>;
  /** Parent provider ids for whitelist ancestry walks. Empty = root/orphan. */
  getParentIds(ctx: AdapterContext, providerFileId: string): Promise<string[]>;
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
/** Bound walk depth when resolving shortcut chains (A → B → …). */
const GOOGLE_SHORTCUT_MAX_HOPS = 5;
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

type GoogleFilePayload = {
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  iconLink?: string | null;
  webViewLink?: string | null;
  size?: string | null;
  modifiedTime?: string | null;
  md5Checksum?: string | null;
  parents?: string[] | null;
  trashed?: boolean | null;
  shortcutDetails?: {
    targetId?: string | null;
    targetMimeType?: string | null;
  } | null;
};

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

  /**
   * Follow Google Drive shortcut hops to the concrete target payload.
   * Data Rooms commonly nest real folders only as shortcuts; without this,
   * recursive indexing classifies them as files and seals after the shallow set.
   */
  private async resolveGoogleTarget(
    ctx: AdapterContext,
    providerFileId: string,
    seed?: GoogleFilePayload | null,
  ): Promise<{ local: GoogleFilePayload; target: GoogleFilePayload }> {
    const drive = this.drive(ctx);
    const load = async (id: string, hint?: GoogleFilePayload | null) => {
      if (hint?.id === id) return hint;
      const res = await drive.files.get({
        fileId: id,
        fields:
          "id,name,mimeType,iconLink,webViewLink,size,modifiedTime,md5Checksum,parents,trashed,shortcutDetails(targetId,targetMimeType)",
        supportsAllDrives: true,
      });
      return res.data as GoogleFilePayload;
    };

    const local = await load(providerFileId, seed);
    if (!local.id) throw httpError(404, "Google file not found");
    if (local.trashed) throw httpError(404, "Google file is trashed");

    const seen = new Set<string>([local.id]);
    let target = local;
    for (let hop = 0; hop < GOOGLE_SHORTCUT_MAX_HOPS; hop += 1) {
      if (target.mimeType !== GOOGLE_SHORTCUT_MIME) {
        return { local, target };
      }
      const targetId = target.shortcutDetails?.targetId?.trim();
      if (!targetId) throw httpError(404, "Google Drive shortcut target missing");
      if (seen.has(targetId)) throw httpError(409, "Google Drive shortcut cycle");
      seen.add(targetId);
      target = await load(targetId);
      if (!target.id) throw httpError(404, "Google file not found");
      if (target.trashed) throw httpError(404, "Google file is trashed");
    }
    if (target.mimeType === GOOGLE_SHORTCUT_MIME) {
      throw httpError(409, "Google Drive shortcut chain too deep");
    }
    return { local, target };
  }

  /**
   * Preserve tree-local identity (shortcut id when present) while exposing the
   * target's type/mime/content fingerprint so discovery can recurse folders and
   * read real files without breaking parent-chain whitelist walks.
   */
  private toAdapterMetadata(
    local: GoogleFilePayload,
    target: GoogleFilePayload,
  ): AdapterMetadata {
    if (!local.id || !target.id) throw httpError(404, "Google file not found");
    const mimeType = target.mimeType ?? null;
    return {
      provider: "google",
      providerFileId: local.id,
      contentProviderFileId: target.id,
      // Prefer the name the user sees in this tree (shortcut label).
      name: local.name ?? target.name ?? local.id,
      mimeType,
      resourceType: mimeType === GOOGLE_FOLDER_MIME ? "folder" : "file",
      iconUrl: target.iconLink ?? local.iconLink ?? null,
      webViewLink: target.webViewLink ?? local.webViewLink ?? null,
      size: target.size ?? null,
      modifiedTime: target.modifiedTime ?? local.modifiedTime ?? null,
      md5Checksum: target.md5Checksum ?? null,
    };
  }

  async getMetadata(
    ctx: AdapterContext,
    providerFileId: string,
  ): Promise<AdapterMetadata> {
    try {
      const { local, target } = await this.resolveGoogleTarget(ctx, providerFileId);
      return this.toAdapterMetadata(local, target);
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
      // List the concrete folder, even when the walk id is a folder shortcut.
      const folder = await this.resolveGoogleTarget(ctx, opts.folderId);
      const folderMeta = this.toAdapterMetadata(folder.local, folder.target);
      if (folderMeta.resourceType !== "folder") {
        throw httpError(400, "listChildren requires a Google folder");
      }
      const listFolderId = folderMeta.contentProviderFileId;

      const res = await drive.files.list({
        q: `'${listFolderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
        pageSize: Math.min(Math.max(opts.pageSize ?? 50, 1), 100),
        pageToken: opts.pageToken,
        fields:
          "nextPageToken, files(id,name,mimeType,iconLink,webViewLink,size,modifiedTime,md5Checksum,shortcutDetails(targetId,targetMimeType))",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const children: AdapterChild[] = [];
      for (const raw of res.data.files ?? []) {
        if (!raw.id) continue;
        try {
          const resolved = await this.resolveGoogleTarget(
            ctx,
            raw.id,
            raw as GoogleFilePayload,
          );
          const meta = this.toAdapterMetadata(resolved.local, resolved.target);
          children.push({
            provider: "google",
            // Keep the id under this parent (shortcut or real) for ancestry.
            providerFileId: meta.providerFileId,
            contentProviderFileId: meta.contentProviderFileId,
            name: meta.name,
            mimeType: meta.mimeType,
            resourceType: meta.resourceType,
            iconUrl: meta.iconUrl,
            webViewLink: meta.webViewLink,
            modifiedTime: meta.modifiedTime,
            md5Checksum: meta.md5Checksum,
          });
        } catch (err) {
          // Broken/denied shortcut targets stay out of discovery rather than
          // failing the whole page; caller can still index reachable peers.
          log.warn("Google Drive shortcut child skipped", {
            parentFolderId: listFolderId,
            shortcutId: raw.id,
            errorName: err instanceof Error ? err.name : typeof err,
          });
        }
      }

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
    opts: { maxBytes?: number | null; mimeType?: string | null },
  ): Promise<AdapterBytes> {
    const drive = this.drive(ctx);
    try {
      const { local, target } = await this.resolveGoogleTarget(ctx, providerFileId);
      const meta = this.toAdapterMetadata(local, target);
      if (meta.resourceType === "folder" || meta.mimeType === GOOGLE_FOLDER_MIME) {
        throw httpError(400, "Cannot read a folder");
      }

      const mimeType = meta.mimeType;
      const name = meta.name;
      const iconUrl = meta.iconUrl;
      const webViewLink = meta.webViewLink;
      const size = meta.size;
      const modifiedTime = meta.modifiedTime;
      const md5Checksum = meta.md5Checksum;
      const resolvedFileId = meta.contentProviderFileId;

      const exportSpec = mimeType ? GOOGLE_EXPORT_MAP[mimeType] : undefined;
      let buffer: Buffer;
      let contentType: string;

      if (exportSpec) {
        const res = await drive.files.export(
          { fileId: resolvedFileId, mimeType: exportSpec.mime },
          { responseType: "arraybuffer" },
        );
        buffer = Buffer.from(res.data as ArrayBuffer);
        contentType = exportSpec.mime;
      } else {
        const res = await drive.files.get(
          {
            fileId: resolvedFileId,
            alt: "media",
            supportsAllDrives: true,
          },
          { responseType: "arraybuffer" },
        );
        buffer = Buffer.from(res.data as ArrayBuffer);
        contentType = mimeType || "application/octet-stream";
      }

      const cap =
        typeof opts.maxBytes === "number" && Number.isFinite(opts.maxBytes) && opts.maxBytes > 0
          ? opts.maxBytes
          : null;
      const truncated = cap != null && buffer.length > cap;
      if (truncated) {
        buffer = buffer.subarray(0, cap);
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

// ── Box ─────────────────────────────────────────────────────────────────────

type BoxItem = {
  id: string;
  type: "file" | "folder" | "web_link";
  name: string;
  size?: number;
  modified_at?: string;
  sha1?: string;
  parent?: { id?: string };
  shared_link?: { url?: string } | null;
  extension?: string;
};

class BoxAdapter implements FilesProviderAdapter {
  readonly provider: FilesProvider = "box";
  private readonly apiBase = "https://api.box.com/2.0";

  private headers(ctx: AdapterContext) {
    if (!ctx.accessToken) throw httpError(403, "Box access unavailable — reconnect Box");
    return { Authorization: `Bearer ${ctx.accessToken}` };
  }

  private async request(ctx: AdapterContext, path: string): Promise<Response> {
    const response = await fetch(`${this.apiBase}${path}`, {
      headers: this.headers(ctx),
      redirect: "follow",
    });
    if (response.status === 401) throw httpError(403, "Box access unavailable — reconnect Box");
    if (response.status === 403) throw httpError(403, "Box item access denied");
    if (response.status === 404) throw httpError(404, "Box item not found");
    if (!response.ok) throw httpError(502, `Box API failed (${response.status})`);
    return response;
  }

  private mime(item: BoxItem): string | null {
    if (item.type === "folder") return "application/vnd.box.folder";
    const extension = item.extension || item.name.split(".").pop()?.toLowerCase();
    const known: Record<string, string> = {
      pdf: "application/pdf",
      txt: "text/plain",
      md: "text/markdown",
      csv: "text/csv",
      json: "application/json",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ppt: "application/vnd.ms-powerpoint",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
    };
    return extension ? known[extension] || "application/octet-stream" : "application/octet-stream";
  }

  private metadata(item: BoxItem): AdapterMetadata {
    return {
      provider: "box",
      providerFileId: item.id,
      contentProviderFileId: item.id,
      name: item.name,
      mimeType: this.mime(item),
      resourceType: item.type === "folder" ? "folder" : "file",
      iconUrl: null,
      webViewLink: item.shared_link?.url || null,
      size: typeof item.size === "number" ? String(item.size) : null,
      modifiedTime: item.modified_at || null,
      md5Checksum: item.sha1 || null,
    };
  }

  private async item(ctx: AdapterContext, id: string): Promise<BoxItem> {
    const fields = "id,type,name,size,modified_at,sha1,parent,shared_link,extension";
    const file = await fetch(
      `${this.apiBase}/files/${encodeURIComponent(id)}?fields=${fields}`,
      { headers: this.headers(ctx) },
    );
    if (file.ok) return file.json() as Promise<BoxItem>;
    if (file.status !== 404) {
      if (file.status === 401 || file.status === 403) throw httpError(403, "Box item access denied");
      throw httpError(502, `Box API failed (${file.status})`);
    }
    return (await this.request(ctx, `/folders/${encodeURIComponent(id)}?fields=${fields}`)).json() as Promise<BoxItem>;
  }

  async getMetadata(ctx: AdapterContext, providerFileId: string): Promise<AdapterMetadata> {
    return this.metadata(await this.item(ctx, providerFileId));
  }

  async listChildren(
    ctx: AdapterContext,
    opts: { folderId: string; pageToken?: string; pageSize?: number },
  ): Promise<{ children: AdapterChild[]; nextPageToken: string | null }> {
    const offset = Number.parseInt(opts.pageToken || "0", 10) || 0;
    const limit = Math.min(Math.max(opts.pageSize || 100, 1), 1000);
    const fields = "id,type,name,size,modified_at,sha1,parent,shared_link,extension";
    const payload = await (await this.request(
      ctx,
      `/folders/${encodeURIComponent(opts.folderId)}/items?limit=${limit}&offset=${offset}&fields=${fields}`,
    )).json() as { entries?: BoxItem[]; total_count?: number; limit?: number };
    const entries = (payload.entries || []).filter((item) => item.type !== "web_link");
    const nextOffset = offset + (payload.limit || limit);
    return {
      children: entries.map((item) => ({ ...this.metadata(item), parentId: opts.folderId })),
      nextPageToken: nextOffset < (payload.total_count || 0) ? String(nextOffset) : null,
    };
  }

  async readBytes(
    ctx: AdapterContext,
    providerFileId: string,
    opts: { maxBytes?: number | null; mimeType?: string | null },
  ): Promise<AdapterBytes> {
    const response = await this.request(ctx, `/files/${encodeURIComponent(providerFileId)}/content`);
    const sourceBuffer = Buffer.from(await response.arrayBuffer());
    const maxBytes = opts.maxBytes ?? null;
    const buffer = maxBytes === null ? sourceBuffer : sourceBuffer.subarray(0, maxBytes);
    return {
      buffer,
      contentType: response.headers.get("content-type") || opts.mimeType || "application/octet-stream",
      byteLength: buffer.length,
      truncated: maxBytes !== null && sourceBuffer.length > maxBytes,
      sourceMimeType: opts.mimeType || null,
    };
  }

  async getParentIds(ctx: AdapterContext, providerFileId: string): Promise<string[]> {
    try {
      const item = await this.item(ctx, providerFileId);
      return item.parent?.id ? [item.parent.id] : [];
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 403 || status === 404) return [];
      throw error;
    }
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
        contentProviderFileId: providerFileId,
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
    opts: { maxBytes?: number | null; mimeType?: string | null },
  ): Promise<AdapterBytes> {
    const ref = await this.refFor(providerFileId);
    try {
      const [buf] = await ref.download();
      const meta = await ref.getMetadata().catch(() => null);
      const cap =
        typeof opts.maxBytes === "number" && Number.isFinite(opts.maxBytes) && opts.maxBytes > 0
          ? opts.maxBytes
          : null;
      const truncated = cap != null && buf.length > cap;
      const buffer = truncated ? buf.subarray(0, cap) : buf;
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


