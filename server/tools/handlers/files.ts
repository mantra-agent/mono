import { MIME_MAP } from "../../lib/mime";
import { objectStorageService } from "../../object_storage";
import {
  inputFailure,
  permissionFailure,
  transientFailure,
  type ToolFailure,
} from "../../tool-failure";
import type { ToolHandler } from "../contracts";
import { contractReject } from "../shared/failures";

/** Classify errors emitted by the canonical Files API/provider boundary. */
export function classifyFilesToolError(err: unknown): ToolFailure | undefined {
  if (!err || typeof err !== "object") return undefined;
  const record = err as {
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  };
  const candidates = [record.status, record.code, record.response?.status];
  const status = candidates.find((value): value is number =>
    typeof value === "number" && Number.isInteger(value),
  );
  if (status === 401 || status === 403) {
    return permissionFailure("files_access_denied", `http_${status}`);
  }
  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) {
    return transientFailure("files_provider_transient", `http_${status}`);
  }
  if (status !== undefined && status >= 400) {
    return inputFailure("files_input_invalid", `http_${status}`);
  }
  return undefined;
}

/** Persistent object-storage and bound-drive handlers. Provider reads stay behind filesApi. */
export const persistentFileHandlers: Readonly<Record<string, ToolHandler>> = {
  async write_file(args) {
    const fileName = args.fileName;
    if (!fileName) {
      return contractReject("Missing fileName", "files_input_invalid");
    }
    const content = args.content;
    if (content === undefined || content === null) {
      return contractReject("Missing file content", "files_input_invalid");
    }

    try {
      const { extname } = await import("path");

      const ext = extname(fileName).toLowerCase();
      const contentType = args.contentType || MIME_MAP[ext] || "application/octet-stream";

      const buffer = Buffer.from(content, "utf-8");
      const { objectPath } = await objectStorageService.uploadObjectEntity(buffer, {
        extension: ext || ".bin",
        contentType,
        acl: { owner: "system", visibility: "public" },
      });

      const encodedName = encodeURIComponent(fileName);
      const downloadLink = `${objectPath}?name=${encodedName}`;
      return { result: `File saved permanently: ${fileName} (${buffer.length} bytes)\nDownload: [${fileName}](${downloadLink})` };
    } catch (err: any) {
      return { result: `Error saving file: ${err.message}`, error: true };
    }
  },

  async read_file(args) {
    const filePath = args.filePath;
    if (!filePath) {
      return contractReject(
        "Missing filePath (the /objects/... path from write_file)",
        "files_input_invalid",
      );
    }

    try {
      const storageService = objectStorageService;

      const objectPath = filePath.startsWith("/objects/") ? filePath : `/objects/${filePath}`;
      const cleanPath = objectPath.split("?")[0];
      const objectFile = await storageService.getObjectEntityFile(cleanPath);
      const [buffer] = await objectFile.download();
      const content = buffer.toString("utf-8");

      const offset = typeof args?.offset === "number" && args.offset >= 0 ? args.offset : 0;
      const limit = typeof args?.limit === "number" && args.limit > 0 ? args.limit : undefined;
      if (offset > 0 || limit !== undefined) {
        const slice = limit !== undefined ? content.slice(offset, offset + limit) : content.slice(offset);
        return { result: `File content (offset=${offset}, showing ${slice.length} of ${content.length} chars):\n\n${slice}` };
      }
      if (content.length > 50000) {
        const { indexAndArchiveWithFallback } = await import("../../content-indexer");
        const refBlock = await indexAndArchiveWithFallback({
          content,
          sourceType: "file",
          sourceLabel: filePath,
        });
        return { result: refBlock };
      }
      return { result: content };
    } catch (err: any) {
      return { result: `Error reading persistent file: ${err.message}`, error: true };
    }
  },

  async list_files(args) {
    try {
      const { storageBackend, PRIVATE_PREFIX } = await import("../../object_storage");
      const { VAULT_PREFIX } = await import("../../object_storage/vault-keys");
      const { requireCurrentPrincipal } = await import("../../principal-context");

      const subPrefix = args.prefix || "uploads/";
      const legacyPrefix = `${PRIVATE_PREFIX}${subPrefix}`;
      const vaultId = requireCurrentPrincipal()?.activeVaultId;
      const vaultPrefix = vaultId ? `${VAULT_PREFIX}${vaultId}/${subPrefix}` : null;

      const [vaultFiles, legacyFiles] = await Promise.all([
        vaultPrefix ? storageBackend.listObjects(vaultPrefix) : Promise.resolve([]),
        storageBackend.listObjects(legacyPrefix),
      ]);
      const entries = [
        ...vaultFiles.map(f => ({ f, prefix: vaultPrefix! })),
        ...legacyFiles.map(f => ({ f, prefix: legacyPrefix })),
      ];

      if (entries.length === 0) return { result: "No persistent files found." };

      const items = entries.map(({ f, prefix }) => {
        const name = f.key;
        const size = f.size ? `${Math.round(f.size / 1024)}KB` : "?";
        const relativeName = name.startsWith(prefix) ? name.slice(prefix.length) : name;
        const downloadPath = `/objects/${subPrefix}${relativeName}`;
        const displayName = relativeName || name;
        const encodedName = encodeURIComponent(displayName);
        return `- ${displayName} (${size}) → [${displayName}](${downloadPath}?name=${encodedName})`;
      });

      return { result: `Persistent files (${entries.length}):\n${items.join("\n")}` };
    } catch (err: any) {
      return { result: `Error listing files: ${err.message}`, error: true };
    }
  },

  async listBound(args) {
    const vaultId = typeof args.vaultId === "string" ? args.vaultId.trim() : "";
    if (!vaultId) {
      return contractReject("Missing vaultId for listBound", "files_input_invalid");
    }
    try {
      const { filesApi } = await import("../../files-api");
      const rows = await filesApi.listBound(vaultId);
      return {
        result: JSON.stringify(
          {
            vaultId,
            count: rows.length,
            bound: rows.map((r) => ({
              driveResourceId: r.id,
              provider: r.provider,
              providerFileId: r.providerFileId,
              name: r.name,
              mimeType: r.mimeType,
              isFolder: r.isFolder,
              accountEmail: r.accountEmail,
              vaultId: r.vaultId,
            })),
          },
          null,
          2,
        ),
      };
    } catch (err: any) {
      return {
        result: `listBound failed: ${err.message}`,
        error: true,
        failure: classifyFilesToolError(err),
      };
    }
  },

  async listChildren(args) {
    const vaultId = typeof args.vaultId === "string" ? args.vaultId.trim() : undefined;
    const driveResourceId = typeof args.driveResourceId === "string" ? args.driveResourceId.trim() : undefined;
    const provider = typeof args.provider === "string" ? args.provider.trim() : undefined;
    const providerFileId = typeof args.providerFileId === "string" ? args.providerFileId.trim() : undefined;
    const pageToken = typeof args.pageToken === "string" ? args.pageToken.trim() : undefined;
    if (!driveResourceId && !(provider && providerFileId)) {
      return contractReject(
        "listChildren requires driveResourceId or provider+providerFileId",
        "files_input_invalid",
      );
    }
    try {
      const { filesApi } = await import("../../files-api");
      const result = await filesApi.listChildren({
        vaultId,
        driveResourceId,
        provider: provider as any,
        providerFileId,
        pageToken: pageToken || null,
      });
      return { result: JSON.stringify(result, null, 2) };
    } catch (err: any) {
      return {
        result: `listChildren failed: ${err.message}`,
        error: true,
        failure: classifyFilesToolError(err),
      };
    }
  },

  async getMetadata(args) {
    const vaultId = typeof args.vaultId === "string" ? args.vaultId.trim() : undefined;
    const driveResourceId = typeof args.driveResourceId === "string" ? args.driveResourceId.trim() : undefined;
    const provider = typeof args.provider === "string" ? args.provider.trim() : undefined;
    const providerFileId = typeof args.providerFileId === "string" ? args.providerFileId.trim() : undefined;
    if (!driveResourceId && !(provider && providerFileId)) {
      return contractReject(
        "getMetadata requires driveResourceId or provider+providerFileId",
        "files_input_invalid",
      );
    }
    try {
      const { filesApi } = await import("../../files-api");
      const metadata = await filesApi.getMetadata({
        vaultId,
        driveResourceId,
        provider: provider as any,
        providerFileId,
      });
      return { result: JSON.stringify(metadata, null, 2) };
    } catch (err: any) {
      return {
        result: `getMetadata failed: ${err.message}`,
        error: true,
        failure: classifyFilesToolError(err),
      };
    }
  },

  async authorize(args) {
    const vaultId = typeof args.vaultId === "string" ? args.vaultId.trim() : undefined;
    const driveResourceId = typeof args.driveResourceId === "string" ? args.driveResourceId.trim() : undefined;
    const provider = typeof args.provider === "string" ? args.provider.trim() : undefined;
    const providerFileId = typeof args.providerFileId === "string" ? args.providerFileId.trim() : undefined;
    if (!driveResourceId && !(provider && providerFileId)) {
      return contractReject(
        "authorize requires driveResourceId or provider+providerFileId",
        "files_input_invalid",
      );
    }
    try {
      const { filesApi } = await import("../../files-api");
      if (driveResourceId) {
        const row = await filesApi.authorize(driveResourceId, vaultId);
        return {
          result: JSON.stringify(
            {
              authorized: true,
              driveResourceId: row.id,
              provider: row.provider,
              providerFileId: row.providerFileId,
              name: row.name,
              mimeType: row.mimeType,
              isFolder: row.isFolder,
              vaultId: row.vaultId,
              accountEmail: row.accountEmail,
            },
            null,
            2,
          ),
        };
      }
      const metadata = await filesApi.getMetadata({
        vaultId,
        provider: provider as any,
        providerFileId,
      });
      return { result: JSON.stringify({ authorized: true, metadata }, null, 2) };
    } catch (err: any) {
      return {
        result: `authorize failed: ${err.message}`,
        error: true,
        failure: classifyFilesToolError(err),
      };
    }
  },
};
