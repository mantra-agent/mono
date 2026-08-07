/**
 * SemanticSourceAdapter registry — thin source loaders for the shared vNext
 * indexing core (queue → hash → extract → provenance → graph).
 *
 * One semantic engine; source type only changes identify/authorize/normalize.
 * Files always load through FilesApi (authorize + staged archive text). Do not
 * add a second indexer or bypass FilesApi for bound drive content.
 */
import { createLogger } from "../log";
import type { VnextSourceType } from "@shared/schema";
import type { MemorySource } from "@shared/schema";
import {
  buildFullSessionContent,
  buildLibraryPageContent,
} from "./vnext-content-chunking";

const log = createLogger("SemanticSourceAdapter");

/** Max characters of drive-file text admitted into one extraction pass. */
const DRIVE_FILE_CONTENT_CHAR_LIMIT = 400_000;

export type SemanticSourceAvailability =
  | "available"
  | "empty"
  | "missing"
  | "unsupported"
  | "inaccessible";

export interface SemanticSourceEnvelope {
  sourceType: VnextSourceType;
  sourceId: string;
  /** Normalized extraction body (already includes title/header lines when useful). */
  content: string;
  title: string;
  topics: string[];
  splitMode: "message" | "paragraph";
  /** Observation `source` vocabulary for applyObservation (not the queue type). */
  observationSource: MemorySource;
  /** Cheap provider/content fingerprint when the adapter can supply one. */
  fingerprint: string | null;
  availability: SemanticSourceAvailability;
  observedAt: Date | null;
}

export interface SemanticSourceAdapter {
  readonly sourceType: VnextSourceType;
  load(sourceId: string): Promise<SemanticSourceEnvelope | null>;
}

const adapters = new Map<VnextSourceType, SemanticSourceAdapter>();

export function registerSemanticSourceAdapter(adapter: SemanticSourceAdapter): void {
  adapters.set(adapter.sourceType, adapter);
}

export function getSemanticSourceAdapter(
  sourceType: string,
): SemanticSourceAdapter | null {
  return adapters.get(sourceType as VnextSourceType) ?? null;
}

export function listSemanticSourceAdapterTypes(): VnextSourceType[] {
  return [...adapters.keys()];
}

const sessionAdapter: SemanticSourceAdapter = {
  sourceType: "session",
  async load(sourceId) {
    const result = await buildFullSessionContent(sourceId);
    if (!result.content.trim()) {
      log.debug(`session adapter: empty id=${sourceId}`);
      return null;
    }

    const titleMatch = result.content.match(/^Session title: (.+)$/m);
    const topicsMatch = result.content.match(/^Topics: (.+)$/m);
    return {
      sourceType: "session",
      sourceId,
      content: result.content,
      title: titleMatch?.[1] || "Untitled Session",
      topics: topicsMatch?.[1]?.split(", ").filter(Boolean) || [],
      splitMode: "message",
      observationSource: "chat_journal",
      fingerprint: null,
      availability: "available",
      observedAt: null,
    };
  },
};

const libraryPageAdapter: SemanticSourceAdapter = {
  sourceType: "library_page",
  async load(sourceId) {
    const result = await buildLibraryPageContent(sourceId);
    if (!result.content.trim()) {
      log.debug(`library_page adapter: empty id=${sourceId}`);
      return null;
    }

    const titleMatch = result.content.match(/^Page title: (.+)$/m);
    const tagsMatch = result.content.match(/^Tags: (.+)$/m);
    return {
      sourceType: "library_page",
      sourceId,
      content: result.content,
      title: titleMatch?.[1] || "Untitled Page",
      topics: tagsMatch?.[1]?.split(", ").filter(Boolean) || [],
      splitMode: "paragraph",
      observationSource: "library",
      fingerprint: null,
      availability: "available",
      observedAt: null,
    };
  },
};

function driveFileFingerprint(meta: {
  md5Checksum: string | null;
  modifiedTime: string | null;
}): string | null {
  if (meta.md5Checksum?.trim()) return `md5:${meta.md5Checksum.trim()}`;
  if (meta.modifiedTime?.trim()) return `modified:${meta.modifiedTime.trim()}`;
  return null;
}

async function loadDriveFileNormalizedText(driveResourceId: string): Promise<{
  text: string;
  metadata: {
    name: string;
    mimeType: string | null;
    provider: string;
    providerFileId: string;
    md5Checksum: string | null;
    modifiedTime: string | null;
    vaultId: string;
  };
  fingerprint: string | null;
  availability: SemanticSourceAvailability;
} | null> {
  const { filesApi } = await import("../files-api");
  const { readFromObjectStorage } = await import("../content-indexer");

  try {
    // Authorize first so missing/unauthorized binds fail closed before download.
    await filesApi.authorize(driveResourceId, "read");
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404 || status === 403 || status === 401) {
      log.warn(`drive_file adapter: inaccessible id=${driveResourceId} status=${status ?? "n/a"}`);
      return {
        text: "",
        metadata: {
          name: driveResourceId,
          mimeType: null,
          provider: "unknown",
          providerFileId: driveResourceId,
          md5Checksum: null,
          modifiedTime: null,
          vaultId: "",
        },
        fingerprint: null,
        availability: "inaccessible",
      };
    }
    throw err;
  }

  let readResult: Awaited<ReturnType<typeof filesApi.read>>;
  try {
    readResult = await filesApi.read({ driveResourceId });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 400) {
      // Folders and other non-file binds are not semantic sources.
      log.debug(`drive_file adapter: unsupported bind id=${driveResourceId}`);
      return {
        text: "",
        metadata: {
          name: driveResourceId,
          mimeType: null,
          provider: "unknown",
          providerFileId: driveResourceId,
          md5Checksum: null,
          modifiedTime: null,
          vaultId: "",
        },
        fingerprint: null,
        availability: "unsupported",
      };
    }
    if (status === 404 || status === 403 || status === 401) {
      log.warn(`drive_file adapter: read inaccessible id=${driveResourceId} status=${status}`);
      return {
        text: "",
        metadata: {
          name: driveResourceId,
          mimeType: null,
          provider: "unknown",
          providerFileId: driveResourceId,
          md5Checksum: null,
          modifiedTime: null,
          vaultId: "",
        },
        fingerprint: null,
        availability: "inaccessible",
      };
    }
    throw err;
  }

  const fingerprint = driveFileFingerprint(readResult.metadata);
  const meta = {
    name: readResult.metadata.name || driveResourceId,
    mimeType: readResult.metadata.mimeType,
    provider: readResult.metadata.provider,
    providerFileId: readResult.metadata.providerFileId,
    md5Checksum: readResult.metadata.md5Checksum,
    modifiedTime: readResult.metadata.modifiedTime,
    vaultId: readResult.metadata.vaultId,
  };

  // Prefer full staged utf8 archive (office-text / text/*) over truncated inline preview.
  let text: string | null = null;
  if (readResult.archive?.encoding === "utf8") {
    text = await readFromObjectStorage(readResult.archive.objectStoragePath);
  }
  if (text == null && readResult.text != null) {
    text = readResult.text;
  }

  if (text == null || !text.trim()) {
    // Binary-only archives are not yet admitted into claim extraction.
    log.debug(
      `drive_file adapter: no normalized text id=${driveResourceId} mime=${meta.mimeType ?? "n/a"} cache=${readResult.cache}`,
    );
    return {
      text: "",
      metadata: meta,
      fingerprint,
      availability: "unsupported",
    };
  }

  if (text.length > DRIVE_FILE_CONTENT_CHAR_LIMIT) {
    text = text.slice(0, DRIVE_FILE_CONTENT_CHAR_LIMIT);
  }

  return {
    text,
    metadata: meta,
    fingerprint,
    availability: "available",
  };
}

function buildDriveFileContent(
  meta: {
    name: string;
    mimeType: string | null;
    provider: string;
    providerFileId: string;
    vaultId: string;
  },
  fingerprint: string | null,
  body: string,
): string {
  const sections: string[] = [];
  sections.push(`File title: ${meta.name || "Untitled File"}`);
  sections.push(`Provider: ${meta.provider}`);
  sections.push(`Provider file id: ${meta.providerFileId}`);
  if (meta.vaultId) sections.push(`Vault: ${meta.vaultId}`);
  if (meta.mimeType) sections.push(`MIME: ${meta.mimeType}`);
  if (fingerprint) sections.push(`Fingerprint: ${fingerprint}`);
  sections.push(`Content:\n${body}`);
  return sections.join("\n\n");
}

const driveFileAdapter: SemanticSourceAdapter = {
  sourceType: "drive_file",
  async load(sourceId) {
    const loaded = await loadDriveFileNormalizedText(sourceId);
    if (!loaded) return null;

    if (loaded.availability !== "available" || !loaded.text.trim()) {
      log.debug(
        `drive_file adapter: skip id=${sourceId} availability=${loaded.availability}`,
      );
      return null;
    }

    const content = buildDriveFileContent(
      loaded.metadata,
      loaded.fingerprint,
      loaded.text,
    );

    return {
      sourceType: "drive_file",
      sourceId,
      content,
      title: loaded.metadata.name || "Untitled File",
      topics: [],
      splitMode: "paragraph",
      observationSource: "file",
      fingerprint: loaded.fingerprint,
      availability: "available",
      observedAt: loaded.metadata.modifiedTime
        ? new Date(loaded.metadata.modifiedTime)
        : null,
    };
  },
};

registerSemanticSourceAdapter(sessionAdapter);
registerSemanticSourceAdapter(libraryPageAdapter);
registerSemanticSourceAdapter(driveFileAdapter);

/**
 * Load normalized source content for the vNext poller through the adapter registry.
 * Unknown types return null (same fail-soft behavior as the prior hard-coded loader).
 */
export async function loadSemanticSourceContent(
  sourceType: string,
  sourceId: string,
): Promise<SemanticSourceEnvelope | null> {
  const adapter = getSemanticSourceAdapter(sourceType);
  if (!adapter) {
    log.warn(`loadSemanticSourceContent: unknown source type=${sourceType}`);
    return null;
  }
  return adapter.load(sourceId);
}
