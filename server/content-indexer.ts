import { createLogger } from "./log";
import { ACTIVITY_FRAMING } from "./job-profiles";
import type { IndexData, IndexSection } from "@shared/models/indexed-content";
import { and, eq } from "drizzle-orm";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithSensitiveVisible, sensitiveOwnershipValues } from "./sensitive-scope";
import type { ObjectAclPolicy } from "./object_storage/objectAcl";

/**
 * Single source of truth for the private ACL policy applied to archived
 * content objects. User-owned when ownership is known, system-scoped otherwise.
 */
function privateVaultAclPolicy(owner: {
  ownerUserId?: string | null;
  accountId?: string | null;
  vaultId?: string | null;
}): ObjectAclPolicy {
  if (owner.ownerUserId) {
    return {
      owner: owner.ownerUserId,
      ownerUserId: owner.ownerUserId,
      accountId: owner.accountId ?? undefined,
      createdByUserId: owner.ownerUserId,
      scope: "user",
      visibility: "private",
      vaultId: owner.vaultId ?? undefined,
    };
  }
  return {
    owner: "system",
    scope: "system",
    visibility: "private",
    vaultId: owner.vaultId ?? undefined,
  };
}

const log = createLogger("ContentIndexer");

const INDEX_CHUNK_SIZE = 80_000;

export interface IndexAndArchiveOptions {
  content: string;
  sourceType: string;
  sourceLabel: string;
  timeoutMs?: number;
  operationKey?: string;
  objectFileName?: string;
}

export interface IndexedReference {
  id: string;
  sourceType: string;
  sourceLabel: string;
  objectStoragePath: string;
  byteCount: number;
  index: IndexData;
}

export async function persistToObjectStorage(
  content: string,
  category: string,
  objectFileName?: string,
): Promise<string | null> {
  try {
    const { storageBackend, vaultObjectKeyAuto } = await import("./object_storage");
    const { setObjectAclPolicy } = await import("./object_storage/objectAcl");
    const { randomUUID } = await import("crypto");
    const filename = objectFileName ?? `${randomUUID()}.txt`;
    const key = vaultObjectKeyAuto(category, filename);
    const buffer = Buffer.from(content, "utf-8");
    await storageBackend.putObject(key, buffer, { contentType: "text/plain; charset=utf-8" });
    const principal = getCurrentPrincipalOrSystem();
    await setObjectAclPolicy(key, privateVaultAclPolicy({
      ownerUserId: principal.userId,
      accountId: principal.accountId,
      vaultId: principal.activeVaultId,
    }));
    const objectKey = `/objects/${category}/${filename}`;
    log.log(`persistToObjectStorage: stored ${buffer.length} bytes at ${objectKey} (category=${category})`);
    return objectKey;
  } catch (err: any) {
    log.warn(`persistToObjectStorage: object storage unavailable, skipping: ${err.message}`);
    return null;
  }
}

export async function readFromObjectStorage(objectPath: string, charOffset?: number, charLength?: number): Promise<string | null> {
  try {
    const { objectStorageService } = await import("./object_storage");
    const cleanPath = objectPath.startsWith("/objects/") ? objectPath : `/objects/${objectPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(cleanPath);
    const [buffer] = await objectFile.download();
    const content = buffer.toString("utf-8");
    if (charOffset !== undefined && charLength !== undefined) {
      return content.slice(charOffset, charOffset + charLength);
    }
    if (charOffset !== undefined) {
      return content.slice(charOffset);
    }
    return content;
  } catch (err: any) {
    log.warn(`readFromObjectStorage: failed to read ${objectPath}: ${err.message}`);
    return null;
  }
}

export async function generateIndex(content: string, sourceType: string, sourceLabel: string, timeoutMs?: number): Promise<IndexData> {
  const singleTimeout = timeoutMs || 30_000;

  try {
    const { getPromptModulePromptEntry } = await import("./prompt-modules");
    const { chatCompletion } = await import("./model-client");

    let systemMsg = "";
    let maxTokens = 3000;
    let activity = ACTIVITY_FRAMING;
    try {
      const entry = await getPromptModulePromptEntry("tools-indexcontent", ACTIVITY_FRAMING);
      systemMsg = entry.prompt;
      activity = entry.activity || ACTIVITY_FRAMING;
    } catch {
      systemMsg = buildDefaultIndexPrompt();
    }

    const contentForIndexing = content.length > INDEX_CHUNK_SIZE
      ? content.slice(0, INDEX_CHUNK_SIZE)
      : content;

    const result = await Promise.race([
      chatCompletion({
        activity,
        messages: [
          { role: "system", content: systemMsg },
          { role: "user", content: `Content type: ${sourceType}\nSource: ${sourceLabel}\nContent (${content.length} chars):\n\n${contentForIndexing}` },
        ],
        maxTokens,
        jsonMode: true,
        metadata: { source: "content-indexer", activity },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Index generation timeout")), singleTimeout)),
    ]);

    const parsed = parseIndexResponse(result.content, content.length);
    return parsed;
  } catch (err: any) {
    log.warn(`generateIndex: LLM indexing failed (${err.message}), using heuristic index`);
    return buildHeuristicIndex(content, sourceType);
  }
}

function parseIndexResponse(raw: string, totalChars: number): IndexData {
  try {
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    }
    const parsed = JSON.parse(cleaned);
    const sections: IndexSection[] = Array.isArray(parsed.sections)
      ? parsed.sections.map((s: any) => ({
          title: String(s.title || "Untitled"),
          byteOffset: Number(s.byteOffset) || 0,
          byteLength: Number(s.byteLength) || 0,
          keyFacts: Array.isArray(s.keyFacts) ? s.keyFacts.map(String) : [],
        }))
      : [];
    return {
      sections,
      keyFacts: Array.isArray(parsed.keyFacts) ? parsed.keyFacts.map(String) : [],
      identifiers: Array.isArray(parsed.identifiers) ? parsed.identifiers.map(String) : [],
      totalChars: Number(parsed.totalChars) || totalChars,
    };
  } catch {
    return {
      sections: [{ title: "Full content", byteOffset: 0, byteLength: totalChars, keyFacts: [] }],
      keyFacts: [],
      identifiers: [],
      totalChars,
    };
  }
}

function buildHeuristicIndex(content: string, sourceType: string): IndexData {
  const sections: IndexSection[] = [];
  const lines = content.split("\n");
  let currentOffset = 0;
  let sectionStart = 0;
  let sectionTitle = "Introduction";
  const keyFacts: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch && currentOffset > sectionStart + 100) {
      sections.push({
        title: sectionTitle,
        byteOffset: sectionStart,
        byteLength: currentOffset - sectionStart,
        keyFacts: [],
      });
      sectionTitle = headingMatch[1].trim();
      sectionStart = currentOffset;
    }
    currentOffset += line.length + 1;
  }

  sections.push({
    title: sectionTitle,
    byteOffset: sectionStart,
    byteLength: currentOffset - sectionStart,
    keyFacts: [],
  });

  if (sections.length === 1 && content.length > 2000) {
    const chunkSize = Math.ceil(content.length / 4);
    const autoSections: IndexSection[] = [];
    for (let i = 0; i < 4; i++) {
      const start = i * chunkSize;
      const len = Math.min(chunkSize, content.length - start);
      if (len <= 0) break;
      autoSections.push({
        title: `Part ${i + 1}`,
        byteOffset: start,
        byteLength: len,
        keyFacts: [],
      });
    }
    return { sections: autoSections, keyFacts, identifiers: [], totalChars: content.length };
  }

  return { sections, keyFacts, identifiers: [], totalChars: content.length };
}

function buildDefaultIndexPrompt(): string {
  return `Produce a JSON index of the provided content with sections, keyFacts, identifiers, and totalChars. Output ONLY valid JSON.`;
}

export async function indexAndArchive(opts: IndexAndArchiveOptions): Promise<IndexedReference | null> {
  const { content, sourceType, sourceLabel, timeoutMs } = opts;

  const objectPath = await persistToObjectStorage(content, sourceType);
  if (!objectPath) {
    log.error(`indexAndArchive failed to persist content sourceType=${sourceType} sourceLabel=${sourceLabel}; durable full-content archive unavailable`);
    return null;
  }

  const indexData = await generateIndex(content, sourceType, sourceLabel, timeoutMs);

  try {
    const { db } = await import("./db");
    const { indexedContent } = await import("@shared/schema");
    const { randomUUID } = await import("crypto");
    const id = randomUUID();

    await db.insert(indexedContent).values({
      id,
      ...sensitiveOwnershipValues(),
      sourceType,
      sourceLabel,
      objectStoragePath: objectPath,
      byteCount: Buffer.byteLength(content, "utf-8"),
      index: indexData,
    });

    log.log(`indexAndArchive: indexed ${sourceType}:${sourceLabel} id=${id} bytes=${Buffer.byteLength(content, "utf-8")} sections=${indexData.sections.length}`);

    return {
      id,
      sourceType,
      sourceLabel,
      objectStoragePath: objectPath,
      byteCount: Buffer.byteLength(content, "utf-8"),
      index: indexData,
    };
  } catch (err: any) {
    log.error(`indexAndArchive DB insert failed sourceType=${sourceType} sourceLabel=${sourceLabel} objectPath=${objectPath}: ${err.message}; durable indexed reference unavailable`);
    return null;
  }
}

export function formatReferenceBlock(ref: IndexedReference): string {
  const parts: string[] = [];
  parts.push(`📎 **Archived Content** [ref:${ref.id}]`);
  parts.push(`Source: ${ref.sourceType} — ${ref.sourceLabel}`);
  parts.push(`Size: ${ref.byteCount.toLocaleString()} bytes | Sections: ${ref.index.sections.length}`);

  if (ref.index.keyFacts.length > 0) {
    parts.push(`\n**Key Facts:**`);
    for (const fact of ref.index.keyFacts.slice(0, 10)) {
      parts.push(`- ${fact}`);
    }
  }

  if (ref.index.sections.length > 0) {
    parts.push(`\n**Sections:**`);
    for (const section of ref.index.sections) {
      const factsPreview = section.keyFacts.length > 0
        ? ` — ${section.keyFacts[0]}${section.keyFacts.length > 1 ? ` (+${section.keyFacts.length - 1} more)` : ""}`
        : "";
      parts.push(`- ${section.title} (${section.byteLength.toLocaleString()} chars)${factsPreview}`);
    }
  }

  if (ref.index.identifiers.length > 0) {
    parts.push(`\n**Identifiers:** ${ref.index.identifiers.slice(0, 10).join(", ")}${ref.index.identifiers.length > 10 ? ` (+${ref.index.identifiers.length - 10} more)` : ""}`);
  }

  parts.push(`\n_Use \`indexed_content\` tool with id="${ref.id}" to retrieve full content or specific sections._`);
  return parts.join("\n");
}


export async function indexAndArchiveHeuristic(opts: IndexAndArchiveOptions): Promise<IndexedReference | null> {
  const { content, sourceType, sourceLabel, operationKey, objectFileName } = opts;
  const owner = sensitiveOwnershipValues();

  if (operationKey) {
    const { db } = await import("./db");
    const { indexedContent } = await import("@shared/schema");
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
            eq(indexedContent.sourceType, sourceType),
            eq(indexedContent.operationKey, operationKey),
          ),
        ),
      )
      .limit(1);
    if (existing) {
      return {
        id: existing.id,
        sourceType: existing.sourceType,
        sourceLabel: existing.sourceLabel,
        objectStoragePath: existing.objectStoragePath,
        byteCount: existing.byteCount,
        index: existing.index,
      };
    }
  }

  const objectPath = await persistToObjectStorage(content, sourceType, objectFileName);
  if (!objectPath) {
    log.error(`indexAndArchiveHeuristic failed to persist content sourceType=${sourceType} sourceLabel=${sourceLabel}; durable full-content archive unavailable`);
    return null;
  }

  const indexData = buildHeuristicIndex(content, sourceType);

  try {
    const { db } = await import("./db");
    const { indexedContent } = await import("@shared/schema");
    const { randomUUID } = await import("crypto");
    const id = randomUUID();
    const byteCount = Buffer.byteLength(content, "utf-8");

    const [inserted] = await db.insert(indexedContent).values({
      id,
      ...owner,
      sourceType,
      operationKey,
      sourceLabel,
      objectStoragePath: objectPath,
      byteCount,
      index: indexData,
    }).onConflictDoNothing().returning();

    if (!inserted && operationKey) {
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
              eq(indexedContent.sourceType, sourceType),
              eq(indexedContent.operationKey, operationKey),
            ),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.objectStoragePath !== objectPath) {
          try {
            await deleteCompactionArchiveObject(objectPath, owner.vaultId ?? null);
          } catch (cleanupError) {
            log.warn(
              `indexAndArchiveHeuristic duplicate object cleanup failed operationKey=${operationKey}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            );
          }
        }
        return {
          id: existing.id,
          sourceType: existing.sourceType,
          sourceLabel: existing.sourceLabel,
          objectStoragePath: existing.objectStoragePath,
          byteCount: existing.byteCount,
          index: existing.index,
        };
      }
    }
    if (!inserted) throw new Error("Indexed archive insert conflicted without a replay-safe match");

    log.log(`indexAndArchiveHeuristic: indexed ${sourceType}:${sourceLabel} id=${inserted.id} bytes=${byteCount} sections=${indexData.sections.length}`);
    return { id: inserted.id, sourceType, sourceLabel, objectStoragePath: objectPath, byteCount, index: indexData };
  } catch (err: any) {
    log.error(`indexAndArchiveHeuristic DB insert failed sourceType=${sourceType} sourceLabel=${sourceLabel} objectPath=${objectPath}: ${err.message}; durable indexed reference unavailable`);
    return null;
  }
}

export async function indexAndArchiveWithFallback(opts: IndexAndArchiveOptions): Promise<string> {
  const ref = await indexAndArchive(opts);
  if (ref) {
    return formatReferenceBlock(ref);
  }
  return heuristicFallbackWithArchive(opts.content, "archive unavailable");
}

export async function readVisibleIndexedContent(options: {
  id: string;
  sourceType?: string;
  charOffset?: number;
  charLength?: number;
}): Promise<{ content: string; sourceLabel: string } | null> {
  const { db } = await import("./db");
  const { indexedContent } = await import("@shared/schema");
  const ownerColumns = {
    ownerUserId: indexedContent.ownerUserId,
    principalAccountId: indexedContent.principalAccountId,
    vaultId: indexedContent.vaultId,
  };
  const domainPredicate = options.sourceType
    ? and(eq(indexedContent.id, options.id), eq(indexedContent.sourceType, options.sourceType))
    : eq(indexedContent.id, options.id);
  const rows = await db
    .select()
    .from(indexedContent)
    .where(combineWithSensitiveVisible(ownerColumns, domainPredicate))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const { objectStorageService } = await import("./object_storage");
  const { getObjectAclPolicy, setObjectAclPolicy } = await import("./object_storage/objectAcl");
  const { ObjectPermission } = await import("./object_storage/objectAcl");
  const principal = getCurrentPrincipalOrSystem();
  const cleanPath = row.objectStoragePath.startsWith("/objects/")
    ? row.objectStoragePath
    : `/objects/${row.objectStoragePath}`;
  const objectFile = await objectStorageService.getObjectEntityFile(cleanPath, principal);
  const existingPolicy = await getObjectAclPolicy(objectFile.key);
  if (!existingPolicy && row.ownerUserId) {
    // Lazy migration: objects archived before ACL stamping inherit their
    // policy from the indexed_content ownership row (single source of truth).
    await setObjectAclPolicy(objectFile.key, privateVaultAclPolicy({
      ownerUserId: row.ownerUserId,
      accountId: row.principalAccountId,
      vaultId: row.vaultId,
    }));
    log.log(`readVisibleIndexedContent: backfilled missing object ACL from row ownership id=${row.id} key=${objectFile.key}`);
  }
  const allowed = await objectStorageService.canAccessObjectEntity({
    principal,
    objectFile,
    requestedPermission: ObjectPermission.READ,
  });
  if (!allowed) return null;
  const [buffer] = await objectFile.download();
  const fullContent = buffer.toString("utf-8");
  const content = options.charOffset === undefined
    ? fullContent
    : fullContent.slice(
        options.charOffset,
        options.charLength === undefined
          ? undefined
          : options.charOffset + options.charLength,
      );
  return { content, sourceLabel: row.sourceLabel };
}

export async function deleteCompactionArchiveObject(
  objectPath: string,
  vaultId: string | null,
): Promise<void> {
  if (!objectPath.startsWith("/objects/")) {
    throw new Error("Compaction archive path is invalid");
  }
  const entityPath = objectPath.slice("/objects/".length);
  if (!entityPath.startsWith("compaction/")) {
    throw new Error("Refusing to delete a non-compaction object");
  }
  const { storageBackend, PRIVATE_PREFIX, VAULT_PREFIX } = await import("./object_storage");
  const { deleteObjectAclPolicy } = await import("./object_storage/objectAcl");
  const key = vaultId
    ? `${VAULT_PREFIX}${vaultId}/${entityPath}`
    : `${PRIVATE_PREFIX}${entityPath}`;
  await storageBackend.deleteObject(key);
  await deleteObjectAclPolicy(key);
}

export function heuristicFallbackWithArchive(content: string, reason: string): string {
  const HEAD_CHARS = 8000;
  const TAIL_CHARS = 4000;
  const head = content.slice(0, HEAD_CHARS);
  const tail = content.length > HEAD_CHARS + TAIL_CHARS
    ? content.slice(-TAIL_CHARS)
    : "";
  const tailSection = tail
    ? `\n\n[... middle content available via indexed_content tool ...]\n\n${tail}`
    : "";
  return `${head}${tailSection}\n\n[Content indexing unavailable (${reason}) — showing first ${HEAD_CHARS} and last ${tail ? TAIL_CHARS : 0} chars of ${content.length} total]`;
}

// ── Streaming-from-file variants (Task #1007 step 6 + 7) ─────────────────
//
// indexAndArchiveFromFile is a sibling of indexAndArchive that takes
// pre-computed byteCount + headChunk + a path to the full content on
// disk. It is called by the shell tool after a worker_threads helper
// has done the heavy CPU/string work (read, trim, byteCount, head
// slice). The full content never enters the main thread's heap — we
// stream it from disk to object storage via createReadStream → file
// .createWriteStream so the upload uses bounded memory regardless of
// stdout size.
//
// LLM indexing uses headChunk only (already small). DB insert uses the
// pre-computed byteCount. Network/DB I/O stays on main intentionally —
// see shell-index-worker.ts for the rationale.

export interface IndexAndArchiveFromFileOptions {
  filePath: string;
  sourceType: string;
  sourceLabel: string;
  byteCount: number;
  headChunk: string;
  totalChars: number;
  timeoutMs?: number;
}

async function persistFileToObjectStorage(filePath: string, category: string): Promise<string | null> {
  try {
    const { storageBackend, vaultObjectKeyAuto } = await import("./object_storage");
    const { setObjectAclPolicy } = await import("./object_storage/objectAcl");
    const { randomUUID } = await import("crypto");
    const fs = await import("fs");
    const fileId = randomUUID();
    const filename = `${fileId}.txt`;
    const key = vaultObjectKeyAuto(category, filename);
    // Stream the file directly from disk so we don't load it into a Buffer.
    const stream = fs.createReadStream(filePath);
    await storageBackend.putObject(key, stream, { contentType: "text/plain; charset=utf-8" });
    const principal = getCurrentPrincipalOrSystem();
    await setObjectAclPolicy(key, privateVaultAclPolicy({
      ownerUserId: principal.userId,
      accountId: principal.accountId,
      vaultId: principal.activeVaultId,
    }));
    const objectKey = `/objects/${category}/${filename}`;
    log.log(`persistFileToObjectStorage: streamed file from ${filePath} to ${objectKey} (category=${category})`);
    return objectKey;
  } catch (err: any) {
    log.warn(`persistFileToObjectStorage: object storage unavailable, skipping: ${err.message}`);
    return null;
  }
}

export async function indexAndArchiveFromFile(opts: IndexAndArchiveFromFileOptions): Promise<IndexedReference | null> {
  const { filePath, sourceType, sourceLabel, byteCount, headChunk, totalChars, timeoutMs } = opts;

  const objectPath = await persistFileToObjectStorage(filePath, sourceType);
  if (!objectPath) {
    log.error(`indexAndArchiveFromFile failed to persist content sourceType=${sourceType} sourceLabel=${sourceLabel}; durable file archive unavailable`);
    return null;
  }

  // generateIndex is happy with whatever string we pass it — we already
  // hold the head chunk (≤ INDEX_CHUNK_SIZE) so this never re-allocates
  // the full content. The function's internal slice() is a no-op when
  // input ≤ INDEX_CHUNK_SIZE.
  const indexData = await generateIndex(headChunk, sourceType, sourceLabel, timeoutMs);
  // Patch totalChars onto the heuristic/parsed result so reference
  // metadata reflects the real content size, not just the head chunk.
  indexData.totalChars = totalChars;

  try {
    const { db } = await import("./db");
    const { indexedContent } = await import("@shared/schema");
    const { randomUUID } = await import("crypto");
    const id = randomUUID();

    await db.insert(indexedContent).values({
      id,
      ...sensitiveOwnershipValues(),
      sourceType,
      sourceLabel,
      objectStoragePath: objectPath,
      byteCount,
      index: indexData,
    });

    log.log(`indexAndArchiveFromFile: indexed ${sourceType}:${sourceLabel} id=${id} bytes=${byteCount} sections=${indexData.sections.length}`);

    return { id, sourceType, sourceLabel, objectStoragePath: objectPath, byteCount, index: indexData };
  } catch (err: any) {
    log.error(`indexAndArchiveFromFile DB insert failed sourceType=${sourceType} sourceLabel=${sourceLabel} objectPath=${objectPath}: ${err.message}; durable indexed reference unavailable`);
    return null;
  }
}

export async function indexAndArchiveFromFileWithFallback(opts: IndexAndArchiveFromFileOptions): Promise<string> {
  const ref = await indexAndArchiveFromFile(opts);
  if (ref) {
    return formatReferenceBlock(ref);
  }
  // Fallback: use the head chunk + a tail estimate. We deliberately
  // don't re-read the full file here — fallback is for when archival
  // failed, and pulling 100MB into main heap to format a fallback
  // block would defeat the off-thread architecture.
  return `${opts.headChunk}\n\n[Content indexing unavailable (archive unavailable) — showing first ${opts.headChunk.length} of ${opts.totalChars} chars]`;
}

export { persistToObjectStorage as persistOriginalContent };
